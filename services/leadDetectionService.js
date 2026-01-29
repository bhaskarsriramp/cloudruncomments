// services/leadDetectionService.js
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import { quickLocalFilter } from "./quickFilter.js"; // 🔥 NEW: Local filter (no HF)
import { analyzeConversationIntent } from "./geminiConversationAnalyser.js";
import { publishConversationUpdate } from "./realtimePublisher.js";

const CONTEXT_MESSAGE_LIMIT = 10;

/**
 * Real-time lead detection triggered on new message
 * Only processes messages from "them" (participants)
 * 
 * Flow:
 * 1. Quick LOCAL filter (instant, 0ms, no API)
 * 2. If meaningful → fetch context + Gemini analysis
 * 3. Update conversation intent
 * 4. Publish to UI in real-time
 */
export async function detectLeadRealtime({
  conversationId,
  messageId,
  messageText,
  creatorId,
  isNewConversation = false,
}) {
  const startTime = Date.now();

  try {
    // ─────────────────────────────────────────────
    // STEP 1: Quick LOCAL Filter (instant, no API)
    // ─────────────────────────────────────────────
    const filterResult = quickLocalFilter(messageText);

    console.log(`[LeadDetect] Filter: "${messageText?.substring(0, 50)}..." → ${filterResult.label} (pass: ${filterResult.passToGemini})`);

    // Update message with filter result
    await Message.updateOne(
      { _id: messageId },
      {
        $set: {
          aiProcess: filterResult.passToGemini ? "processing" : "completed",
          processedAt: filterResult.passToGemini ? undefined : new Date(),
          filterLabel: filterResult.label,
          filterConfidence: filterResult.confidence,
        },
      }
    );

    // If noise, skip Gemini analysis (save cost + time)
    if (!filterResult.passToGemini) {
      return {
        processed: true,
        filtered: true,
        reason: "LOCAL_FILTERED",
        label: filterResult.label,
        confidence: filterResult.confidence,
        executionMs: Date.now() - startTime,
      };
    }

    // ─────────────────────────────────────────────
    // STEP 2: Build Conversation Context
    // ─────────────────────────────────────────────
    let contextMessages = [];

    if (isNewConversation) {
      // For new conversations, just use the current message
      console.log(`[LeadDetect] New conversation - analyzing single message`);
      contextMessages = [
        {
          sender: "them",
          text: messageText,
          createdAtPlatform: new Date(),
        },
      ];
    } else {
      // Existing conversation - fetch context from DB
      const recentMessages = await Message.find({
        conversationId,
        text: { $ne: null, $ne: "" },
      })
        .sort({ createdAtPlatform: -1 })
        .limit(CONTEXT_MESSAGE_LIMIT)
        .select("sender text createdAtPlatform")
        .lean();

      if (recentMessages.length === 0) {
        // Fallback: use current message if DB query returns nothing
        contextMessages = [
          {
            sender: "them",
            text: messageText,
            createdAtPlatform: new Date(),
          },
        ];
      } else {
        // Reverse to chronological order (oldest first)
        contextMessages = recentMessages.reverse();
      }
    }

    console.log(`[LeadDetect] Analyzing ${contextMessages.length} messages with Gemini...`);

    // ─────────────────────────────────────────────
    // STEP 3: Gemini Conversation Analysis
    // ─────────────────────────────────────────────
    const geminiResult = await analyzeConversationIntent(contextMessages);

    // Mark message as processed
    await Message.updateOne(
      { _id: messageId },
      {
        $set: {
          aiProcess: "completed",
          processedAt: new Date(),
          intentSource: geminiResult.error ? "local+gemini-fallback" : "local+gemini",
          geminiIntent: geminiResult.intent,
          geminiConfidence: geminiResult.confidence,
          geminiLeadScore: geminiResult.leadScore,
        },
      }
    );

    // ─────────────────────────────────────────────
    // STEP 4: Update Conversation
    // ─────────────────────────────────────────────
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const previousIntent = conversation.conversationIntent || "General";
    const intentChanged = previousIntent !== geminiResult.intent;
    const now = new Date();

    // Update if:
    // 1. Intent changed, OR
    // 2. Lead score increased, OR
    // 3. New conversation (always set initial intent)
    const shouldUpdate =
      isNewConversation ||
      intentChanged ||
      (geminiResult.intent === "Lead" &&
        geminiResult.leadScore > (conversation.conversationLeadSeriousness || 0));

    if (shouldUpdate) {
      conversation.conversationIntent = geminiResult.intent;
      conversation.conversationIntentConfidence = geminiResult.confidence;
      conversation.conversationIntentUpdatedAt = now;

      if (geminiResult.intent === "Lead") {
        conversation.conversationLeadSeriousness = geminiResult.leadScore;
        conversation.conversationLeadSeriousnessUpdatedAt = now;
        conversation.leadFactors = geminiResult.factors;
      }

      conversation.label = geminiResult.intent;
      conversation.labelSource = "ai";

      await conversation.save();

      // ─────────────────────────────────────────────
      // STEP 5: Publish to UI (Real-time update)
      // ─────────────────────────────────────────────
      await publishConversationUpdate({
        creatorId: creatorId.toString(),
        conversationId: conversationId.toString(),
        update: {
          label: geminiResult.intent,
          labelIntentConfidence: geminiResult.confidence,
          labelLeadSeriousness: geminiResult.leadScore || 0,
          factors: geminiResult.factors || [],
        },
      });

      console.log(
        `[LeadDetect] ✅ ${isNewConversation ? "[NEW] " : ""}${previousIntent} → ${geminiResult.intent} (confidence: ${geminiResult.confidence}, leadScore: ${geminiResult.leadScore})`
      );
    } else {
      console.log(
        `[LeadDetect] ℹ️ No change: ${previousIntent} (analyzed: ${geminiResult.intent})`
      );
    }

    return {
      processed: true,
      filtered: false,
      isNewConversation,
      previousIntent,
      newIntent: geminiResult.intent,
      intentChanged: shouldUpdate,
      confidence: geminiResult.confidence,
      leadScore: geminiResult.leadScore,
      factors: geminiResult.factors,
      messagesAnalyzed: contextMessages.length,
      executionMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error("[LeadDetect] ❌ Error:", err.message);

    // Mark message as failed
    try {
      await Message.updateOne(
        { _id: messageId },
        { $set: { aiProcess: "failed", aiProcessError: err.message } }
      );
    } catch (updateErr) {
      // Ignore update errors
    }

    return {
      processed: false,
      error: err.message,
      executionMs: Date.now() - startTime,
    };
  }
}
// services/leadDetectionService.js
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import { zeroShotSingleFilter } from "./zeroShot.js";
import { analyzeConversationIntent } from "./geminiConversationAnalyser.js";
import { publishConversationUpdate } from "./realtimePublisher.js";

const CONTEXT_MESSAGE_LIMIT = 10;

/**
 * Real-time lead detection triggered on new message
 * Only processes messages from "them" (participants)
 */
export async function detectLeadRealtime({
  conversationId,
  messageId,
  messageText,
  creatorId,
  isNewConversation = false, // 🔥 NEW FLAG
}) {
  const startTime = Date.now();

  try {
    // ─────────────────────────────────────────────
    // STEP 1: Quick HF Filter (is this meaningful?)
    // ─────────────────────────────────────────────
    const hfResult = await zeroShotSingleFilter(messageText);

    // Update message with HF result
    await Message.updateOne(
      { _id: messageId },
      {
        $set: {
          aiProcess: hfResult.passToGemini ? "processing" : "completed",
          processedAt: hfResult.passToGemini ? undefined : new Date(),
          hfLabel: hfResult.label,
          hfConfidence: hfResult.confidence,
        },
      }
    );

    // If noise, skip Gemini analysis
    if (!hfResult.passToGemini) {
      console.log(`[LeadDetect] Message filtered by HF: ${hfResult.label}`);
      return {
        processed: true,
        filtered: true,
        reason: "HF_FILTERED",
        label: hfResult.label,
        executionMs: Date.now() - startTime,
      };
    }

    // ─────────────────────────────────────────────
    // STEP 2: Build Conversation Context
    // ─────────────────────────────────────────────
    let contextMessages = [];

    if (isNewConversation) {
      // 🔥 NEW: For new conversations, just use the current message
      // No need to query DB - we already have what we need
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
          intentSource: geminiResult.error ? "hf+gemini-fallback" : "hf+gemini",
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
        `[LeadDetect] ✅ ${isNewConversation ? "NEW" : ""} ${previousIntent} → ${geminiResult.intent} (confidence: ${geminiResult.confidence}, leadScore: ${geminiResult.leadScore})`
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
      // Ignore
    }

    return {
      processed: false,
      error: err.message,
      executionMs: Date.now() - startTime,
    };
  }
}
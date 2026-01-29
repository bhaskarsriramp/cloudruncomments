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
          aiProcess: "completed",
          processedAt: new Date(),
          hfLabel: hfResult.label,
          hfConfidence: hfResult.confidence,
        },
      }
    );

    // If noise, skip Gemini analysis
    if (!hfResult.passToCgemini) {
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
    // STEP 2: Fetch Conversation Context
    // ─────────────────────────────────────────────
    const recentMessages = await Message.find({
      conversationId,
      text: { $ne: null, $ne: "" },
    })
      .sort({ createdAtPlatform: -1 })
      .limit(CONTEXT_MESSAGE_LIMIT)
      .select("sender text createdAtPlatform")
      .lean();

    if (recentMessages.length === 0) {
      return {
        processed: true,
        filtered: true,
        reason: "NO_MESSAGES",
        executionMs: Date.now() - startTime,
      };
    }

    // Reverse to chronological order (oldest first)
    const contextMessages = recentMessages.reverse();

    // ─────────────────────────────────────────────
    // STEP 3: Gemini Conversation Analysis
    // ─────────────────────────────────────────────
    const geminiResult = await analyzeConversationIntent(contextMessages);

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

    // Only update if intent changed OR lead score increased
    const shouldUpdate =
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
      }

      conversation.label = geminiResult.intent;
      conversation.labelSource = "ai";

      await conversation.save();

      // ─────────────────────────────────────────────
      // STEP 5: Publish to UI (Real-time update)
      // ─────────────────────────────────────────────
      await publishConversationUpdate({
        creatorId,
        conversationId,
        update: {
          label: geminiResult.intent,
          labelIntentConfidence: geminiResult.confidence,
          labelLeadSeriousness: geminiResult.leadScore || 0,
          factors: geminiResult.factors || [],
        },
      });

      console.log(
        `[LeadDetect] ✅ ${previousIntent} → ${geminiResult.intent} (${geminiResult.confidence})`
      );
    }

    return {
      processed: true,
      filtered: false,
      previousIntent,
      newIntent: geminiResult.intent,
      intentChanged,
      confidence: geminiResult.confidence,
      leadScore: geminiResult.leadScore,
      factors: geminiResult.factors,
      executionMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error("[LeadDetect] ❌ Error:", err.message);

    // Don't block message flow on lead detection failure
    return {
      processed: false,
      error: err.message,
      executionMs: Date.now() - startTime,
    };
  }
}
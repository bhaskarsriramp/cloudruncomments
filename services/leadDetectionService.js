// services/leadDetectionService.js
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import User from "../models/User.js";
import Participant from "../models/Participant.js";
import DmsUsage from "../models/DmsUsage.js";
import crypto from "crypto";
import MagicToken from "../models/MagicToken.js";
import { analyzeConversationIntent } from "./geminiConversationAnalyser.js";
import { publishConversationUpdate } from "./realtimePublisher.js";
import { sendWhatsAppAlert } from "./whatsappMessage.js";


const CONTEXT_MESSAGE_LIMIT = 15;

/**
 * Real-time lead detection + follow-up detection
 * Triggered on new message from participants
 * 
 * NO LOCAL FILTERING - Every message goes to Gemini for full context analysis
 * 
 * FOLLOW-UP LOGIC:
 * - Follow-up is ONLY applicable if creator has replied at least once
 * - If creator has replied AND last message is from user → followUp.needed = true
 * - If creator has replied AND last message is from creator (user went silent) → followUp.needed = true (re-engage)
 * - If creator has NEVER replied → followUp.needed = false (it's just a new message)
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
    // ─────────────────────────────────────────────────────
    // STEP 1: Skip only truly empty messages
    // ─────────────────────────────────────────────────────
    if (!messageText || messageText.trim() === "") {
      console.log(`[LeadDetect] Skipping empty message`);
      
      await Message.updateOne(
        { _id: messageId },
        {
          $set: {
            aiProcess: "skipped",
            processedAt: new Date(),
            skipReason: "empty_message",
          },
        }
      );
      
      return {
        processed: false,
        reason: "EMPTY_MESSAGE",
        executionMs: Date.now() - startTime,
      };
    }

    console.log(`[LeadDetect] Processing: "${messageText.substring(0, 50)}..."`);

    // Mark as processing
    await Message.updateOne(
      { _id: messageId },
      { $set: { aiProcess: "processing" } }
    );

    // ─────────────────────────────────────────────────────
    // STEP 2: Build Conversation Context
    // Include ALL recent messages for full context
    // ─────────────────────────────────────────────────────
    let contextMessages = [];
    let creatorHasReplied = false;

    if (isNewConversation) {
      console.log(`[LeadDetect] New conversation - analyzing single message`);
      contextMessages = [
        {
          sender: "them",
          text: messageText,
          createdAtPlatform: new Date(),
        },
      ];
      creatorHasReplied = false; // New conversation = creator hasn't replied
    } else {
      // Fetch recent messages (BOTH sides for full context)
      const recentMessages = await Message.find({
        conversationId,
        text: { $exists: true, $ne: null },
      })
        .sort({ createdAtPlatform: -1, _id: 1 })
        .limit(CONTEXT_MESSAGE_LIMIT)
        .select("sender text type createdAtPlatform")
        .lean();

      if (recentMessages.length === 0) {
        contextMessages = [
          {
            sender: "them",
            text: messageText,
            createdAtPlatform: new Date(),
          },
        ];
        creatorHasReplied = false;
      } else {
        // Reverse to chronological order (oldest first)
        contextMessages = recentMessages.reverse();
        
        // 🔥 CRITICAL: Check if creator has replied at least once (system messages don't count)
        creatorHasReplied = recentMessages.some(m => m.sender === "me" && m.type !== "system");
      }
    }

    // Determine who sent the last message
    const lastMessage = contextMessages[contextMessages.length - 1];
    const lastSenderIsUser = lastMessage?.sender !== "me";

    console.log(`[LeadDetect] Analyzing ${contextMessages.length} messages | CreatorHasReplied: ${creatorHasReplied} | LastMsgFromUser: ${lastSenderIsUser}`);

    // ─────────────────────────────────────────────────────
    // STEP 3: Gemini Analysis (Intent + Follow-up)
    // 🔥 Pass creatorHasReplied to Gemini
    // ─────────────────────────────────────────────────────
    const geminiResult = await analyzeConversationIntent(contextMessages, creatorHasReplied);

    // 🔥 CRITICAL: If Gemini failed, DON'T downgrade existing lead data
    if (geminiResult.error) {
      console.log(`[LeadDetect] ⚠️ Gemini error - preserving existing conversation data`);
      
      // Mark message as failed but don't change conversation
      await Message.updateOne(
        { _id: messageId },
        {
          $set: {
            aiProcess: "failed",
            processedAt: new Date(),
            aiProcessError: "Gemini analysis failed",
          },
        }
      );
      
      return {
        processed: false,
        reason: "GEMINI_ERROR",
        preservedExistingData: true,
        executionMs: Date.now() - startTime,
      };
    }

    // Mark message as processed
    await Message.updateOne(
      { _id: messageId },
      {
        $set: {
          aiProcess: "completed",
          processedAt: new Date(),
          intentSource: geminiResult.error ? "gemini-fallback" : "gemini",
          geminiIntent: geminiResult.intent,
          geminiConfidence: geminiResult.confidence,
          geminiLeadScore: geminiResult.leadScore,
          geminiLeadQuality: geminiResult.leadQuality,
        },
      }
    );

    // ─────────────────────────────────────────────────────
    // STEP 4: Update Conversation (Intent + Follow-up)
    // ─────────────────────────────────────────────────────
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const previousIntent = conversation.conversationIntent || "General";
    const intentChanged = previousIntent !== geminiResult.intent;
    const now = new Date();

    // Never downgrade from Lead to General — once a lead, only a human can change it back
    const isDowngrade = previousIntent === "Lead" && geminiResult.intent === "General";
    if (isDowngrade) {
      console.log(`[LeadDetect] 🛡️ Skipping downgrade from Lead to General for conversation ${conversationId}`);
    }

    // Check if intent should update
    const shouldUpdateIntent =
      isNewConversation ||
      (intentChanged && !isDowngrade) ||
      (geminiResult.intent === "Lead" &&
        geminiResult.leadScore > (conversation.conversationLeadSeriousness || 0));

    // Check if follow-up status changed
    const previousFollowUpNeeded = conversation.followUpStatus?.needed || false;
    const newFollowUpNeeded = geminiResult.followUp.needed;
    const followUpChanged = previousFollowUpNeeded !== newFollowUpNeeded ||
      conversation.followUpStatus?.priority !== geminiResult.followUp.priority;

    // Update conversation if anything changed
    if (shouldUpdateIntent || followUpChanged) {
      
      // Update intent fields
      if (shouldUpdateIntent) {
        conversation.conversationIntent = geminiResult.intent;
        conversation.conversationIntentConfidence = geminiResult.confidence;
        conversation.conversationIntentUpdatedAt = now;

        if (geminiResult.intent === "Lead") {
          conversation.conversationLeadSeriousness = geminiResult.leadScore;
          conversation.conversationLeadSeriousnessUpdatedAt = now;
          conversation.conversationLeadQuality = geminiResult.leadQuality;
          conversation.leadFactors = geminiResult.factors;
          conversation.leadUserContext = geminiResult.userContext || null;
        } else {
          // Clear lead fields if not a lead
          conversation.conversationLeadSeriousness = 0;
          conversation.conversationLeadQuality = "none";
          conversation.leadFactors = [];
          conversation.leadUserContext = null;
        }

        conversation.labelSource = "ai";
      }

      // 🔥 Update follow-up status
      // The Gemini analyzer already handles the creatorHasReplied logic
      if (newFollowUpNeeded) {
        conversation.followUpStatus = {
          needed: true,
          priority: geminiResult.followUp.priority,
          reason: geminiResult.followUp.reason,
          suggestedAction: geminiResult.followUp.suggestedAction,
          detectedAt: conversation.followUpStatus?.needed ? conversation.followUpStatus.detectedAt : now,
          dismissedAt: null,
          completedAt: null,
        };
      } else {
        conversation.followUpStatus = {
          needed: false,
          priority: null,
          reason: geminiResult.followUp.reason || "No follow-up needed",
          suggestedAction: null,
          detectedAt: null,
          dismissedAt: null,
          completedAt: null,
        };
      }
      conversation.followUpAnalyzedAt = now;

      await conversation.save();

      // ─────────────────────────────────────────────────────
      // STEP 4.5: WhatsApp Lead Alert (fire-and-forget)
      // Send alert if serious lead detected & not already alerted
      // ─────────────────────────────────────────────────────
      if (
        geminiResult.intent === "Lead" &&
        conversation.conversationLeadSeriousness > 0.65 &&
        !conversation.whatsappAlertMessageId
      ) {
        try {
          const user = await User.findById(creatorId).select("creator_whatsapp_num leads_plan_limit");
          const currentUsage = await DmsUsage.findOne({
            user_id: creatorId,
            year: now.getFullYear(),
            month: now.getMonth() + 1,
          }).select("lead_alerts_sent").lean();
          const currentLeadAlerts = currentUsage?.lead_alerts_sent || 0;

          if (user?.creator_whatsapp_num && currentLeadAlerts < user.leads_plan_limit) {
            const participant = await Participant.findById(conversation.participantId).select("name username");
            const leadName = participant?.name || participant?.username || "Someone";
            const leadMessage = conversation.leadUserContext || "Interested in your services";

            const magicTokenStr = crypto.randomBytes(32).toString("hex");
                                  await MagicToken.create({
                                    token: magicTokenStr,
                                    user_id: creatorId,
                                    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                                    chatUsername: participant?.username || null,
                                  });

            const result = await sendWhatsAppAlert(
              user.creator_whatsapp_num,
              leadName,
              leadMessage,
              magicTokenStr
            );

            const wamid = result?.messages?.[0]?.id;
            if (wamid) {
              conversation.whatsappAlertMessageId = wamid;
              conversation.whatsappAlertSentAt = now;
              await conversation.save();
              const updatedUsage = await DmsUsage.findOneAndUpdate(
                { user_id: creatorId, year: now.getFullYear(), month: now.getMonth() + 1 },
                { $inc: { lead_alerts_sent: 1 } },
                { new: true, upsert: true }
              );
              if (updatedUsage.lead_alerts_sent >= user.leads_plan_limit) {
                await User.updateOne({ _id: creatorId }, { $set: { lead_agent: false } });
                console.log(`[LeadDetect] 🛑 Lead limit reached (${updatedUsage.lead_alerts_sent}/${user.leads_plan_limit}) — lead_agent disabled`);
              }
              console.log(`[LeadDetect] 📱 WhatsApp alert sent | wamid: ${wamid}`);
            }
          }
        } catch (alertErr) {
          console.error(`[LeadDetect] ⚠️ WhatsApp alert failed (non-blocking):`, alertErr.message);
        }
      }

      // ─────────────────────────────────────────────────────
      // STEP 5: Publish to UI (Fire-and-forget - NO await)
      // 🔥 FIXED: Include lastParticipantMessageAt AND creatorHasReplied
      // ─────────────────────────────────────────────────────
      publishConversationUpdate({
        creatorId: creatorId.toString(),
        conversationId: conversationId.toString(),
        update: {
          // Intent fields
          label: conversation.conversationIntent,
          labelIntentConfidence: geminiResult.confidence,
          labelLeadSeriousness: geminiResult.leadScore || 0,
          labelLeadQuality: geminiResult.leadQuality || "none",
          factors: geminiResult.factors || [],
          
          // Follow-up fields
          followUpStatus: conversation.followUpStatus,
          
          // 🔥 CRITICAL: Include these so frontend can compute category correctly
          lastParticipantMessageAt: conversation.lastParticipantMessageAt,
          creatorHasReplied: creatorHasReplied, // 🔥 NEW: Include this!
        },
      });

      console.log(
        `[LeadDetect] ✅ ${isNewConversation ? "[NEW] " : ""}Intent: ${previousIntent} → ${geminiResult.intent} | LeadScore: ${geminiResult.leadScore?.toFixed(2)} (${geminiResult.leadQuality}) | CreatorReplied: ${creatorHasReplied} | LastMsgFromUser: ${lastSenderIsUser} | FollowUp: ${conversation.followUpStatus.needed ? conversation.followUpStatus.priority : "not needed"}`
      );
    } else {
      console.log(
        `[LeadDetect] ℹ️ No changes: Intent=${previousIntent}, LeadScore=${geminiResult.leadScore?.toFixed(2)}, CreatorReplied=${creatorHasReplied}, FollowUp=${previousFollowUpNeeded ? "needed" : "not needed"}`
      );
    }

    return {
      processed: true,
      isNewConversation,
      previousIntent,
      newIntent: geminiResult.intent,
      intentChanged: shouldUpdateIntent,
      confidence: geminiResult.confidence,
      leadScore: geminiResult.leadScore,
      leadQuality: geminiResult.leadQuality,
      factors: geminiResult.factors,
      followUp: geminiResult.followUp,
      followUpChanged,
      creatorHasReplied,
      lastSenderIsUser,
      messagesAnalyzed: contextMessages.length,
      executionMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error("[LeadDetect] ❌ Error:", err.message);

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
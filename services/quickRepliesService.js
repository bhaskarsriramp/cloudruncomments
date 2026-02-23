// services/quickRepliesService.js
//
// Generates 3 contextual quick reply suggestions for a conversation.
//
// HOW IT WORKS:
//   1. Fetches the last 6 messages from the conversation (context window)
//   2. Fetches or builds the creator's style DNA (from creatorStyleService)
//   3. Sends both to Gemini with the conversation intent + lead quality
//   4. Caches the 3 suggestions on Conversation.quickReplies.suggestions
//   5. Cache is keyed by lastMessageId — auto-invalidated when a new message arrives
//
// GRACEFUL DEGRADATION:
//   Gemini fails → intent-specific fallback templates
//   Fallback fails → hardcoded generic replies (never a blank list)

import { VertexAI } from "@google-cloud/vertexai";
import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import { getCreatorStyleProfile } from "./creatorStyleService.js";

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

// Slightly higher temperature than lead analysis — we want creative, varied replies
const repliesModel = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 500,
  },
});

const CONTEXT_MESSAGE_LIMIT = 6;

// Fallback suggestions when Gemini is unavailable — grouped by conversation intent
const FALLBACKS = {
  Lead: [
    { text: "Hey! Tell me more about your goals 💪", intent: "ask-details" },
    { text: "Absolutely! What are you looking to achieve?", intent: "warm-opener" },
    { text: "Let's figure out the best plan for you!", intent: "soft-close" },
  ],
  Business: [
    { text: "Hey! Tell me more about the collaboration 🙌", intent: "ask-details" },
    { text: "Sounds interesting! What did you have in mind?", intent: "warm-opener" },
    { text: "Drop me the details and let's chat!", intent: "soft-close" },
  ],
  General: [
    { text: "Hi! Thanks for reaching out 😊", intent: "warm-opener" },
    { text: "Hey! What did you have in mind?", intent: "ask-details" },
    { text: "Happy to help — what's up?", intent: "warm-opener" },
  ],
};

/**
 * Returns 3 quick reply suggestions for a conversation.
 * Returns cached suggestions if the last message hasn't changed.
 * Falls back to intent-specific templates on Gemini failure.
 *
 * @param {string|ObjectId} conversationId
 * @param {string|ObjectId} creatorId
 * @returns {Promise<Array<{ text: string, intent: string }>>}
 */
export async function generateQuickReplies(conversationId, creatorId) {
  try {
    // ── 1. Fetch conversation metadata ───────────────────────────────────────
    const conversation = await Conversation.findById(conversationId)
      .select("conversationIntent conversationLeadQuality quickReplies")
      .lean();

    if (!conversation) {
      console.warn(`[QuickReplies] Conversation ${conversationId} not found — using fallback`);
      return FALLBACKS.General;
    }

    const intent = conversation.conversationIntent || "General";
    const leadQuality = conversation.conversationLeadQuality || "none";

    // ── 2. Fetch last N messages (context window) ────────────────────────────
    const recentMessages = await Message.find({
      conversationId,
      text: { $exists: true, $ne: null },
    })
      .sort({ createdAtPlatform: -1 })
      .limit(CONTEXT_MESSAGE_LIMIT)
      .select("sender text type createdAtPlatform igMessageId")
      .lean();

    if (recentMessages.length === 0) {
      console.log(`[QuickReplies] No messages found for ${conversationId} — using fallback`);
      return FALLBACKS[intent] || FALLBACKS.General;
    }

    // recentMessages is desc-sorted; [0] is the newest message
    const lastMsg = recentMessages[0];

    // ── 3. Cache hit check ───────────────────────────────────────────────────
    // Suggestions are still valid if the last message in the conversation
    // has not changed since we last generated them.
    const cached = conversation.quickReplies;
    if (
      cached?.suggestions?.length > 0 &&
      cached.lastMessageId === lastMsg.igMessageId
    ) {
      console.log(`[QuickReplies] Cache hit for conversation ${conversationId}`);
      return cached.suggestions;
    }

    // ── 4. Fetch creator style DNA ───────────────────────────────────────────
    const styleProfile = await getCreatorStyleProfile(creatorId);

    // ── 5. Build conversation context (chronological for the prompt) ─────────
    const chronologicalMessages = [...recentMessages].reverse();
    const conversationText = chronologicalMessages
      .map((m) => {
        const role = m.sender === "me" ? "Creator" : "User";
        const text = (m.text || "").replace(/[\r\n]+/g, " ").trim().substring(0, 200);
        return `${role}: ${text}`;
      })
      .join("\n");

    // ── 6. Build and call Gemini ─────────────────────────────────────────────
    const prompt = buildPrompt({
      styleProfile,
      conversationText,
      intent,
      leadQuality,
    });

    const response = await repliesModel.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const rawText = response.response.candidates?.[0]?.content?.parts?.[0]?.text;
    const jsonMatch = rawText?.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in Gemini quick replies response");

    const parsed = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(parsed.replies) || parsed.replies.length === 0) {
      throw new Error("Gemini returned empty or malformed replies array");
    }

    const suggestions = parsed.replies.slice(0, 3).map((r) => ({
      text: String(r.text || "").substring(0, 300),
      intent: String(r.intent || "warm-opener"),
    }));

    // ── 7. Persist suggestions to Conversation (cache) ───────────────────────
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: {
          "quickReplies.suggestions": suggestions,
          "quickReplies.generatedAt": new Date(),
          "quickReplies.lastMessageId": lastMsg.igMessageId,
        },
      }
    );

    console.log(
      `[QuickReplies] ✅ Generated ${suggestions.length} replies for conversation ${conversationId} (intent: ${intent}, leadQuality: ${leadQuality})`
    );

    return suggestions;
  } catch (err) {
    console.error(`[QuickReplies] ⚠️ Generation failed: ${err.message}`);

    // Best-effort fallback: try to read intent from DB for a smarter fallback
    try {
      const conv = await Conversation.findById(conversationId)
        .select("conversationIntent")
        .lean();
      const intent = conv?.conversationIntent || "General";
      return FALLBACKS[intent] || FALLBACKS.General;
    } catch {
      return FALLBACKS.General;
    }
  }
}

/**
 * Builds the Gemini prompt for quick reply generation.
 * Kept as a separate function so it's easy to iterate on the prompt
 * without touching the orchestration logic above.
 */
function buildPrompt({ styleProfile, conversationText, intent, leadQuality }) {
  const catchphraseLine =
    styleProfile.catchphrases?.length > 0
      ? styleProfile.catchphrases.join(", ")
      : "none recorded";

  const intentGuidance = {
    Lead: `This is a potential customer conversation (lead quality: ${leadQuality}). Replies should warmly guide the user toward sharing their fitness goals or taking the next step. For hot/high leads, at least one reply should nudge toward action.`,
    Business: `This is a business/collaboration inquiry. Replies should show genuine interest and ask for more details about the opportunity.`,
    General: `This is a general conversation. Replies should be warm, helpful, and conversational — keep the engagement going naturally.`,
  };

  return `You are generating quick reply suggestions for an Instagram fitness creator to send to a follower.
The replies MUST sound exactly like the creator writes — match their tone, emoji habits, and message length precisely.

## CREATOR STYLE PROFILE
Tone: ${styleProfile.tone}
Emoji usage: ${styleProfile.emojiUsage}
Message length: ${styleProfile.avgLength}
Common phrases: ${catchphraseLine}
Writing style: ${styleProfile.writingGuidelines}

## CONVERSATION (last ${Math.min(6, conversationText.split("\n").length)} messages)
${conversationText}

## CONVERSATION INTELLIGENCE
Intent: ${intent}
Lead Quality: ${leadQuality}
Context: ${intentGuidance[intent] || intentGuidance.General}

## INSTRUCTIONS
Generate exactly 3 quick replies the creator can send next. Each reply must:
1. Be directly relevant to what the user last said — do NOT write generic replies
2. Sound exactly like the creator (match their style profile — tone, emojis, length)
3. Serve a clearly different purpose so the creator has genuine choice
4. Be concise — maximum 2 short sentences
5. Never start all 3 replies the same way

Respond ONLY with valid JSON (no markdown, no backticks, no explanation):
{
  "replies": [
    { "text": "...", "intent": "ask-details" },
    { "text": "...", "intent": "warm-opener" },
    { "text": "...", "intent": "soft-close" }
  ]
}

Intent options for the "intent" field: ask-details | warm-opener | soft-close | reassure | follow-up`;
}

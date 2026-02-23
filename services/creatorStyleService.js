// services/creatorStyleService.js
//
// Builds and caches a "style DNA" for a creator by analysing their sent DMs.
// The profile is stored on User.creatorStyleProfile and is considered fresh
// until either:
//   1. 24 hours have passed since last analysis, OR
//   2. The creator has sent 15+ new messages since the last analysis
//
// If the creator has fewer than 10 sent messages we return a fitness-creator
// default so the system never fails cold.

import { VertexAI } from "@google-cloud/vertexai";
import User from "../models/User.js";
import Message from "../models/Message.js";

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

const styleModel = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 600,
  },
});

const STYLE_SAMPLE_LIMIT = 50;
const INVALIDATE_AFTER_NEW_MESSAGES = 15;
const STYLE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_MESSAGES_TO_ANALYZE = 10;

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Used when a creator is new or Gemini fails — reads naturally for a fitness account
const FITNESS_CREATOR_DEFAULT = {
  tone: "casual-energetic",
  emojiUsage: "occasional",
  avgLength: "short",
  catchphrases: [],
  writingGuidelines:
    "Writes in a friendly, motivating tone typical of a fitness coach. Keeps replies concise and encouraging. Uses a warm, conversational style without being overly formal.",
};

/**
 * Returns the creator's style profile — from cache or freshly built.
 * Never throws; falls back to FITNESS_CREATOR_DEFAULT on any error.
 *
 * @param {string|ObjectId} creatorId
 * @returns {Promise<Object>} Style profile object
 */
export async function getCreatorStyleProfile(creatorId) {
  try {
    const user = await User.findById(creatorId)
      .select("creatorStyleProfile")
      .lean();

    if (!user) {
      console.warn(`[StyleService] Creator ${creatorId} not found — using default`);
      return FITNESS_CREATOR_DEFAULT;
    }

    const cached = user.creatorStyleProfile;

    // Count how many real text messages this creator has sent in total
    const currentSentCount = await Message.countDocuments({
      senderId: creatorId,
      sender: "me",
      type: "text",
      text: { $exists: true, $ne: null },
    });

    const isExpired =
      !cached?.lastAnalyzedAt ||
      Date.now() - new Date(cached.lastAnalyzedAt).getTime() > STYLE_MAX_AGE_MS;

    const hasTooManyNewMessages =
      cached?.sentMessageCountAtAnalysis != null &&
      currentSentCount >= cached.sentMessageCountAtAnalysis + INVALIDATE_AFTER_NEW_MESSAGES;

    if (cached?.writingGuidelines && !isExpired && !hasTooManyNewMessages) {
      console.log(`[StyleService] Cache hit for creator ${creatorId}`);
      return cached;
    }

    // Cache is stale or missing — rebuild
    return buildAndCacheStyleProfile(creatorId, currentSentCount);
  } catch (err) {
    console.error(`[StyleService] getCreatorStyleProfile error: ${err.message} — using default`);
    return FITNESS_CREATOR_DEFAULT;
  }
}

/**
 * Fetches the creator's sent messages, calls Gemini to extract their writing
 * style, then persists the result on User.creatorStyleProfile.
 *
 * @param {string|ObjectId} creatorId
 * @param {number} currentSentCount - Pre-counted total sent messages (avoids double query)
 * @returns {Promise<Object>} Style profile object
 */
async function buildAndCacheStyleProfile(creatorId, currentSentCount) {
  const sentMessages = await Message.find({
    senderId: creatorId,
    sender: "me",
    type: "text",
    text: { $exists: true, $ne: null },
  })
    .sort({ createdAtPlatform: -1 })
    .limit(STYLE_SAMPLE_LIMIT)
    .select("text")
    .lean();

  // Not enough data yet — use default and do NOT persist so we try again next time
  if (sentMessages.length < MIN_MESSAGES_TO_ANALYZE) {
    console.log(
      `[StyleService] Creator ${creatorId} has only ${sentMessages.length} sent messages — using default (need ${MIN_MESSAGES_TO_ANALYZE})`
    );
    return FITNESS_CREATOR_DEFAULT;
  }

  const messageList = sentMessages
    .map((m, i) => `${i + 1}. "${m.text.replace(/[\r\n]+/g, " ").trim().substring(0, 150)}"`)
    .join("\n");

  const prompt = `You are analysing the writing style of an Instagram fitness creator based on their real DM messages sent to followers.

Here are ${sentMessages.length} messages this creator sent:
${messageList}

Study how they write — their tone, emoji habits, sentence length, vocabulary, personality — and return ONLY valid JSON (no markdown, no backticks, no explanation):
{
  "tone": "one of: casual-energetic | friendly-professional | hype | calm-supportive | motivational | conversational",
  "emojiUsage": "one of: frequent | occasional | none",
  "avgLength": "one of: short | medium | long",
  "catchphrases": ["up to 5 short phrases or words they commonly use — exact quotes preferred"],
  "writingGuidelines": "A single paragraph (max 80 words) describing exactly how this creator writes so another AI can perfectly mimic their style when generating replies. Include tone, emoji habits, message length, and any distinctive patterns."
}`;

  let profile = null;
  let retries = 0;
  let delay = INITIAL_DELAY_MS;

  try {
    while (retries < MAX_RETRIES) {
      try {
        const response = await styleModel.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        });

        const rawText = response.response.candidates?.[0]?.content?.parts?.[0]?.text;
        const jsonMatch = rawText?.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found in Gemini style response");

        const parsed = JSON.parse(jsonMatch[0]);

        profile = {
          tone: String(parsed.tone || "conversational"),
          emojiUsage: String(parsed.emojiUsage || "occasional"),
          avgLength: String(parsed.avgLength || "short"),
          catchphrases: Array.isArray(parsed.catchphrases)
            ? parsed.catchphrases.slice(0, 5).map(String)
            : [],
          writingGuidelines: String(
            parsed.writingGuidelines || FITNESS_CREATOR_DEFAULT.writingGuidelines
          ),
          lastAnalyzedAt: new Date(),
          sentMessageCountAtAnalysis: currentSentCount,
        };

        break; // success — exit retry loop

      } catch (err) {
        retries++;

        const isRateLimited =
          err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");
        const isTransient =
          err.message?.includes("500") || err.message?.includes("503");

        if ((isRateLimited || isTransient) && retries < MAX_RETRIES) {
          console.warn(`[StyleService] Retry ${retries}/${MAX_RETRIES} after ${delay}ms — ${err.message}`);
          await sleep(delay);
          delay = Math.min(delay * 2, MAX_DELAY_MS);
          continue;
        }

        // Non-retryable error or retries exhausted — bubble up to fallback
        throw err;
      }
    }

    if (!profile) throw new Error("Style profile generation failed after max retries");

    await User.updateOne(
      { _id: creatorId },
      { $set: { creatorStyleProfile: profile } }
    );

    console.log(
      `[StyleService] ✅ Style profile built for creator ${creatorId}: tone="${profile.tone}", emojis="${profile.emojiUsage}", length="${profile.avgLength}", phrases=[${profile.catchphrases.join(", ")}]`
    );

    return profile;
  } catch (err) {
    console.error(`[StyleService] ⚠️ Gemini style analysis failed: ${err.message} — using default`);
    return FITNESS_CREATOR_DEFAULT;
  }
}

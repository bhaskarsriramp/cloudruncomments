// services/geminiConversationAnalyser.js
import { VertexAI } from "@google-cloud/vertexai";

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

const model = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 512,
  },
});

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `
You analyze Instagram DM conversations for fitness creators to identify potential leads.

Given a conversation history, classify the OVERALL conversation intent as ONE of:
- General (casual chat, greetings, no buying intent)
- Lead (interested in fitness programs, coaching, pricing)
- Business (collaboration, sponsorship, partnership)

Also estimate:
- confidence (0.0-1.0): How confident you are in this classification
- leadScore (0.0-1.0): How serious/ready is this person to buy (only if Lead)
- factors: Array of reasons for your classification

Rules:
- Look at the FULL conversation context, not just the last message
- Asking about price/program = Lead
- Sharing goals (weight loss, fitness) + asking questions = Lead
- Just saying "hi" or compliments = General
- Mentioning brand deals, sponsorships = Business
- Be conservative - prefer General if unsure

Respond ONLY with valid JSON (no markdown):
{
  "intent": "General|Lead|Business",
  "confidence": 0.0,
  "leadScore": 0.0,
  "factors": ["reason1", "reason2"]
}
`;

/**
 * Analyze full conversation context
 */
export async function analyzeConversationIntent(messages) {
  if (!messages || messages.length === 0) {
    return {
      intent: "General",
      confidence: 0,
      leadScore: 0,
      factors: ["No messages"],
    };
  }

  // Build conversation context
  const conversationText = messages
    .map((m) => {
      const sender = m.sender === "me" ? "Creator" : "User";
      const text = (m.text || "").replace(/[\r\n]+/g, " ").substring(0, 200);
      return `${sender}: ${text}`;
    })
    .join("\n");

  const prompt = `${SYSTEM_PROMPT}\n\nConversation:\n${conversationText}`;

  let retries = 0;
  let delay = INITIAL_DELAY_MS;

  while (retries < MAX_RETRIES) {
    try {
      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });

      const text = response.response.candidates[0]?.content?.parts[0]?.text;

      if (!text) {
        throw new Error("Empty Gemini response");
      }

      // Extract JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        intent: parsed.intent || "General",
        confidence: Number((parsed.confidence || 0).toFixed(3)),
        leadScore: Number((parsed.leadScore || 0).toFixed(3)),
        factors: parsed.factors || [],
      };
    } catch (err) {
      retries++;

      const isRateLimited =
        err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");

      const isTransient =
        err.message?.includes("500") || err.message?.includes("503");

      if ((isRateLimited || isTransient) && retries < MAX_RETRIES) {
        console.warn(`[Gemini] Retry ${retries}/${MAX_RETRIES} after ${delay}ms`);
        await sleep(delay);
        delay *= 2;
        continue;
      }

      console.error("[Gemini] Failed:", err.message);
      return {
        intent: "General",
        confidence: 0,
        leadScore: 0,
        factors: ["Analysis failed"],
        error: true,
      };
    }
  }
}
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
    maxOutputTokens: 800,
  },
});

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `
You analyze Instagram DM conversations for fitness creators to:
1. Identify potential leads/customers
2. Accurately score lead SERIOUSNESS (not just interest)
3. Detect if follow-up is needed

## PART 1: INTENT CLASSIFICATION

Classify the OVERALL conversation intent as ONE of:
- General (casual chat, greetings, no buying intent)
- Lead (interested in fitness programs, coaching, pricing)
- Business (collaboration, sponsorship, partnership)

## PART 2: LEAD SCORE (CRITICAL - READ CAREFULLY)

The leadScore (0.0-1.0) measures how SERIOUS and READY TO BUY the user is.
This is NOT just about showing interest - it's about purchase readiness.

### LEAD SCORE RUBRIC:

**0.0-0.2 (Not a Lead / Noise)**
- Just greetings ("Hi", "Hello")
- Random questions unrelated to services
- Single word responses

**0.2-0.4 (Casual Inquiry - LOW quality lead)**
- Generic questions like "What programs do you have?"
- "What do you offer?"
- "Tell me about your services"
- No personal context or goals shared
- Just browsing/exploring, not committed

**0.4-0.6 (Interested but Uncommitted - MEDIUM quality lead)**
- Asking about pricing WITHOUT sharing goals
- Asking about timing/schedule
- Shows some interest but vague about needs
- "How much does it cost?"
- "When are your classes?"

**0.6-0.8 (Serious Intent - HIGH quality lead)**
- Shares SPECIFIC fitness goals (e.g., "lose 10kg", "build muscle")
- Mentions specific services they want (e.g., "1:1 coaching", "diet plan")
- Asks detailed questions about methodology
- Shows urgency ("I want to start soon", "this month")
- Shares current situation ("I'm 85kg, want to reach 65kg")

**0.8-1.0 (Hot Lead - VERY HIGH quality, ready to convert)**
- Explicitly asks HOW TO JOIN/ENROLL
- Asks for payment details
- Shares contact info (phone, WhatsApp)
- Says "I'm ready to start" / "Sign me up"
- Already decided, just needs logistics
- Mentions budget they're willing to spend

### CRITICAL DISTINCTION:

❌ "What programs do you have?" = 0.3 (just browsing)
✅ "I want to lose 25kg, do you have 1:1 coaching?" = 0.75 (specific goal + specific service)

❌ "How much?" = 0.4 (price shopping)
✅ "I'm 85kg, want to reach 60kg in 6 months. What's your 1:1 coaching fee?" = 0.8 (specific goal + timeline + service)

❌ "Do you have online coaching?" = 0.35 (general inquiry)
✅ "I work from home and need online coaching. I've been trying to lose weight for 2 years. Can you help?" = 0.7 (context + pain point + specific need)

## PART 3: FOLLOW-UP DETECTION

Analyze if the creator needs to follow up with this user.

Follow-up is needed when:
- User asked a question that creator hasn't answered
- Creator replied but user went silent (potential interest lost)
- User showed interest but conversation stalled
- User said "will think about it" / "let me check" / "later"
- Pricing was discussed but no closure
- User seemed interested but didn't commit

Follow-up is NOT needed when:
- Conversation just started (< 2 messages)
- User clearly said no/not interested
- User already enrolled/converted
- Creator is waiting for user's response to a question
- Last message is from user (ball is in creator's court to respond, not follow-up)

Priority levels:
- high: Hot lead gone cold (leadScore > 0.6), pricing discussed, strong interest shown
- medium: Moderate interest (leadScore 0.4-0.6), general inquiry unanswered
- low: Mild interest (leadScore < 0.4), casual conversation stalled

## RESPONSE FORMAT

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "intent": "General|Lead|Business",
  "confidence": 0.85,
  "leadScore": 0.0,
  "leadQuality": "none|low|medium|high|hot",
  "factors": ["reason1", "reason2"],
  "followUp": {
    "needed": true|false,
    "priority": "high|medium|low|null",
    "reason": "Brief explanation of why follow-up is needed or not",
    "suggestedAction": "Specific suggestion for what creator should do (only if needed)"
  }
}

## RULES
- Be conservative with intent - prefer General if unsure
- Be STRICT with leadScore - most inquiries are 0.2-0.5, not 0.6+
- Only give leadScore > 0.6 if user shares SPECIFIC goals or asks HOW TO JOIN
- Be helpful with follow-up - help creator not lose leads
- suggestedAction should be specific and actionable
- If followUp.needed is false, set priority to null and suggestedAction to null
- Set leadQuality based on score: none(0-0.2), low(0.2-0.4), medium(0.4-0.6), high(0.6-0.8), hot(0.8-1.0)
`;

/**
 * Extract JSON from Gemini response
 */
function extractJson(text) {
  if (!text || typeof text !== "string") return null;

  // Try direct JSON match
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue
    }
  }

  // Try markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // Continue
    }
  }

  return null;
}

/**
 * Map leadScore to quality label
 */
function getLeadQuality(score) {
  if (score >= 0.8) return "hot";
  if (score >= 0.6) return "high";
  if (score >= 0.4) return "medium";
  if (score >= 0.2) return "low";
  return "none";
}

/**
 * Analyze conversation for intent AND follow-up status
 * @param {Array<{ sender: string, text: string, createdAtPlatform: Date }>} messages
 * @returns {Promise<{ intent, confidence, leadScore, leadQuality, factors, followUp }>}
 */
export async function analyzeConversationIntent(messages) {
  if (!messages || messages.length === 0) {
    return {
      intent: "General",
      confidence: 0,
      leadScore: 0,
      leadQuality: "none",
      factors: ["No messages to analyze"],
      followUp: {
        needed: false,
        priority: null,
        reason: "No messages",
        suggestedAction: null,
      },
    };
  }

  // Build conversation context with timestamps for better follow-up detection
  const now = new Date();
  const conversationText = messages
    .map((m) => {
      const sender = m.sender === "me" ? "Creator" : "User";
      const text = (m.text || "").replace(/[\r\n]+/g, " ").trim().substring(0, 200);
      
      // Calculate time ago for context
      let timeAgo = "";
      if (m.createdAtPlatform) {
        const msgDate = new Date(m.createdAtPlatform);
        const hoursAgo = Math.floor((now - msgDate) / (1000 * 60 * 60));
        if (hoursAgo < 24) {
          timeAgo = `(${hoursAgo}h ago)`;
        } else {
          const daysAgo = Math.floor(hoursAgo / 24);
          timeAgo = `(${daysAgo}d ago)`;
        }
      }
      
      return `${sender} ${timeAgo}: ${text}`;
    })
    .join("\n");

  // Add context about last message
  const lastMessage = messages[messages.length - 1];
  const lastSender = lastMessage?.sender === "me" ? "Creator" : "User";
  
  const contextNote = `\n\n[Last message was from: ${lastSender}]`;

  const fullPrompt = `${SYSTEM_PROMPT}\n\nConversation (${messages.length} messages):\n${conversationText}${contextNote}`;

  let retries = 0;
  let delay = INITIAL_DELAY_MS;

  while (retries < MAX_RETRIES) {
    try {
      const response = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      });

      const text = response.response.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error("Empty Gemini response");
      }

      const parsed = extractJson(text);

      if (!parsed) {
        console.error("[Gemini] Failed to parse JSON:", text.substring(0, 200));
        throw new Error("Invalid JSON response");
      }

      // Validate and normalize intent
      const intent = ["General", "Lead", "Business"].includes(parsed.intent)
        ? parsed.intent
        : "General";

      const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
      
      // Calculate leadScore (only for Lead intent)
      let leadScore = 0;
      if (intent === "Lead") {
        leadScore = Math.min(1, Math.max(0, Number(parsed.leadScore) || 0));
      }

      // Determine lead quality from score
      const leadQuality = intent === "Lead" ? getLeadQuality(leadScore) : "none";

      const factors = Array.isArray(parsed.factors)
        ? parsed.factors.slice(0, 5).map(String)
        : [];

      // Validate and normalize follow-up
      const followUp = {
        needed: Boolean(parsed.followUp?.needed),
        priority: ["high", "medium", "low"].includes(parsed.followUp?.priority)
          ? parsed.followUp.priority
          : null,
        reason: parsed.followUp?.reason ? String(parsed.followUp.reason).substring(0, 200) : null,
        suggestedAction: parsed.followUp?.suggestedAction 
          ? String(parsed.followUp.suggestedAction).substring(0, 300) 
          : null,
      };

      // If not needed, clear other fields
      if (!followUp.needed) {
        followUp.priority = null;
        followUp.suggestedAction = null;
      }

      console.log(`[Gemini] Intent: ${intent} (${confidence.toFixed(2)}) | LeadScore: ${leadScore.toFixed(2)} (${leadQuality}) | FollowUp: ${followUp.needed ? followUp.priority : 'not needed'}`);

      return {
        intent,
        confidence: Number(confidence.toFixed(3)),
        leadScore: Number(leadScore.toFixed(3)),
        leadQuality,
        factors,
        followUp,
        error: false,
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
        delay = Math.min(delay * 2, MAX_DELAY_MS);
        continue;
      }

      if (err.message?.includes("Invalid JSON") && retries < MAX_RETRIES) {
        console.warn(`[Gemini] Parse retry ${retries}/${MAX_RETRIES}`);
        await sleep(delay);
        continue;
      }

      console.error("[Gemini] Failed:", err.message);

      return {
        intent: "General",
        confidence: 0,
        leadScore: 0,
        leadQuality: "none",
        factors: ["Analysis failed"],
        followUp: {
          needed: false,
          priority: null,
          reason: "Analysis failed",
          suggestedAction: null,
        },
        error: true,
      };
    }
  }

  // Should never reach here
  return {
    intent: "General",
    confidence: 0,
    leadScore: 0,
    leadQuality: "none",
    factors: ["Max retries exceeded"],
    followUp: {
      needed: false,
      priority: null,
      reason: "Max retries exceeded",
      suggestedAction: null,
    },
    error: true,
  };
}
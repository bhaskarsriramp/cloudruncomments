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
3. Detect if the creator needs to FOLLOW UP (respond to avoid missing a lead)

You will receive ALL messages including greetings, short replies, and nudges. Analyze the FULL conversation context.

## PART 1: INTENT CLASSIFICATION

Classify the OVERALL conversation intent as ONE of:
- General (casual chat, greetings, no buying intent)
- Lead (interested in fitness programs, coaching, pricing)
- Business (collaboration, sponsorship, partnership)

IMPORTANT: Intent should reflect the ENTIRE conversation, not just the latest message.
- If user previously showed lead intent but latest message is "??" → Still a Lead
- If conversation started with lead interest → Keep as Lead until clearly abandoned

## PART 2: LEAD SCORE (CRITICAL - READ CAREFULLY)

The leadScore (0.0-1.0) measures how SERIOUS and READY TO BUY the user is.
This is NOT just about showing interest - it's about purchase readiness.

### LEAD SCORE RUBRIC:

**0.0-0.2 (Not a Lead / Noise)**
- Just greetings ("Hi", "Hello") with no follow-up
- Random questions unrelated to services
- Single word responses with no context

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

## PART 3: FOLLOW-UP DETECTION (⚠️ CRITICAL - READ VERY CAREFULLY)

"Follow-up" in this platform means: **Creator needs to respond to avoid missing a potential lead.**

The goal is to help creators NOT MISS conversations that need their attention.

### ⚠️ PREREQUISITE FOR FOLLOW-UP:
**Creator must have sent AT LEAST ONE message in the conversation.**
- If Creator has NEVER replied → followUp.needed = FALSE (it's just a new message, not a follow-up)
- If Creator HAS replied before → Evaluate if they need to follow up

### FOLLOW-UP IS NEEDED (followUp.needed = TRUE) WHEN:

**Prerequisite: Creator has replied at least once in this conversation**

Then, if ANY of the following:

1. **Last message is from User** (Creator might miss replying!)
   - User asked a question → Creator should respond
   - User sent any message → Creator should acknowledge
   - User is waiting for response → High priority
   - User sent "??" or "hello?" → Very high priority (user is actively waiting)

2. **Last message is from Creator, but conversation stalled**
   - Creator replied, user showed interest but went silent
   - User said "let me think" / "will check" → Creator should follow up later
   - Hot lead (leadScore > 0.6) went cold → Re-engage

### FOLLOW-UP IS NOT NEEDED (followUp.needed = FALSE) WHEN:

1. **Creator has NEVER replied** 
   - Only user messages exist
   - This is just a new/pending message, NOT a follow-up situation

2. **User explicitly declined**
   - "Not interested", "No thanks", "Maybe later", "Not now"
   - No point in following up

3. **User already converted/enrolled**

4. **Conversation naturally concluded**
   - User said "Thanks!", "Got it!", etc. with no pending question

### PRIORITY LEVELS (only when followUp.needed = TRUE):

- **high**: 
  - User is actively waiting ("??", "hello?", repeated messages)
  - Hot lead (leadScore > 0.6) asked a question
  - User asked about pricing/enrollment
  
- **medium**: 
  - User asked a general question
  - Moderate interest (leadScore 0.4-0.6)
  - User sent a message that needs acknowledgment
  
- **low**: 
  - Casual conversation
  - User sent something but low lead potential
  - Creator replied, user went silent (re-engage attempt)

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
    "reason": "Brief explanation",
    "suggestedAction": "What creator should do (only if needed)"
  }
}

## RULES
- Analyze the FULL conversation, not just the last message
- If user previously showed lead intent, maintain that context
- Be STRICT with leadScore - most inquiries are 0.2-0.5, not 0.6+
- Only give leadScore > 0.6 if user shares SPECIFIC goals or asks HOW TO JOIN
- Set leadQuality based on score: none(0-0.2), low(0.2-0.4), medium(0.4-0.6), high(0.6-0.8), hot(0.8-1.0)
- ⚠️ CRITICAL: followUp.needed can ONLY be true if Creator has sent at least one message
- If Creator has replied AND last message is from User → Usually followUp.needed = true (unless user declined)
- If followUp.needed is false, set priority to null and suggestedAction to null
`;

/**
 * Extract JSON from Gemini response
 */
function extractJson(text) {
  if (!text || typeof text !== "string") return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue
    }
  }

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
 * @param {boolean} creatorHasReplied - Whether creator has sent at least one message
 * @returns {Promise<{ intent, confidence, leadScore, leadQuality, factors, followUp }>}
 */
export async function analyzeConversationIntent(messages, creatorHasReplied = false) {
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

  // 🔥 Check if creator has replied (from messages array as backup)
  const hasCreatorMessage = creatorHasReplied || messages.some(m => m.sender === "me");
  
  // Determine last message sender
  const lastMessage = messages[messages.length - 1];
  const lastMessageFromUser = lastMessage?.sender !== "me";
  
  // Build conversation context
  const now = new Date();
  const conversationText = messages
    .map((m) => {
      const sender = m.sender === "me" ? "Creator" : "User";
      const text = (m.text || "[empty]").replace(/[\r\n]+/g, " ").trim().substring(0, 200);
      
      let timeAgo = "";
      if (m.createdAtPlatform) {
        const msgDate = new Date(m.createdAtPlatform);
        const hoursAgo = Math.floor((now - msgDate) / (1000 * 60 * 60));
        if (hoursAgo < 1) {
          const minsAgo = Math.floor((now - msgDate) / (1000 * 60));
          timeAgo = `(${minsAgo}m ago)`;
        } else if (hoursAgo < 24) {
          timeAgo = `(${hoursAgo}h ago)`;
        } else {
          const daysAgo = Math.floor(hoursAgo / 24);
          timeAgo = `(${daysAgo}d ago)`;
        }
      }
      
      return `${sender} ${timeAgo}: ${text}`;
    })
    .join("\n");

  // 🔥 Add critical context about creator participation and last message
  const contextNote = `

[Conversation State]
- Total messages: ${messages.length}
- Creator has replied in this conversation: ${hasCreatorMessage ? "YES" : "NO"}
- Last message from: ${lastMessageFromUser ? "User" : "Creator"}
- Follow-up eligible: ${hasCreatorMessage ? "YES (creator has engaged)" : "NO (creator hasn't replied yet - this is just a new message)"}
${hasCreatorMessage && lastMessageFromUser ? "- ⚠️ User is waiting for creator's response!" : ""}`;

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
      
      let leadScore = 0;
      if (intent === "Lead") {
        leadScore = Math.min(1, Math.max(0, Number(parsed.leadScore) || 0));
      }

      const leadQuality = intent === "Lead" ? getLeadQuality(leadScore) : "none";

      const factors = Array.isArray(parsed.factors)
        ? parsed.factors.slice(0, 5).map(String)
        : [];

      // 🔥 CRITICAL: Determine follow-up based on creator participation
      let followUpNeeded = Boolean(parsed.followUp?.needed);
      let followUpReason = parsed.followUp?.reason ? String(parsed.followUp.reason).substring(0, 200) : null;
      
      // RULE 1: If creator has never replied, follow-up is NOT applicable
      if (!hasCreatorMessage) {
        followUpNeeded = false;
        followUpReason = "Creator hasn't replied yet - this is a new message, not a follow-up situation";
        console.log(`[Gemini] 🚫 Follow-up disabled: Creator hasn't replied yet`);
      }
      
      // RULE 2: If creator has replied AND last message is from user, likely needs follow-up
      // (unless user declined - Gemini should catch that)
      if (hasCreatorMessage && lastMessageFromUser && !followUpNeeded) {
        // Gemini said no follow-up needed, but let's check if it makes sense
        // Trust Gemini's judgment here (user might have said "no thanks")
        console.log(`[Gemini] ℹ️ Creator replied, last msg from user, but Gemini says no follow-up: ${followUpReason}`);
      }

      const followUp = {
        needed: followUpNeeded,
        priority: followUpNeeded && ["high", "medium", "low"].includes(parsed.followUp?.priority)
          ? parsed.followUp.priority
          : null,
        reason: followUpReason,
        suggestedAction: followUpNeeded && parsed.followUp?.suggestedAction 
          ? String(parsed.followUp.suggestedAction).substring(0, 300) 
          : null,
      };

      console.log(`[Gemini] Intent: ${intent} (${confidence.toFixed(2)}) | LeadScore: ${leadScore.toFixed(2)} (${leadQuality}) | CreatorReplied: ${hasCreatorMessage} | LastMsgFromUser: ${lastMessageFromUser} | FollowUp: ${followUp.needed ? followUp.priority : 'not needed'}`);

      return {
        intent,
        confidence: Number(confidence.toFixed(3)),
        leadScore: Number(leadScore.toFixed(3)),
        leadQuality,
        factors,
        followUp,
        creatorHasReplied: hasCreatorMessage,
        lastMessageFromUser,
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
        creatorHasReplied: hasCreatorMessage,
        lastMessageFromUser,
        error: true,
      };
    }
  }

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
    creatorHasReplied: hasCreatorMessage,
    lastMessageFromUser,
    error: true,
  };
}
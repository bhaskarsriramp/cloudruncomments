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
    maxOutputTokens: 1500, // 🔥 Increased from 800 to prevent truncation
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
3. Detect if the creator needs to FOLLOW UP (respond to user / re-engage)

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

"Follow-up" helps creators NOT MISS leads. It flags conversations where the creator needs to respond or re-engage.

### ⚠️ PREREQUISITE FOR FOLLOW-UP:
**Creator must have sent AT LEAST ONE message in the conversation.**
- If Creator has NEVER replied → followUp.needed = FALSE (it's just a new message, not a follow-up)
- If Creator has replied at least once → Evaluate if follow-up is needed

### FOLLOW-UP IS NEEDED (followUp.needed = TRUE) WHEN:

Creator has engaged (replied at least once) AND one of:

1. **Last message is from User** (Creator might miss/forget to reply!)
   - User asked a question → Creator should respond
   - User sent any message → Creator should acknowledge
   - User sent "??" or "hello?" → Creator DEFINITELY needs to respond (high priority)
   - User shared information → Creator should continue conversation

2. **Last message is from Creator BUT user was interested and went silent**
   - Creator replied, user showed interest but stopped responding
   - Potential lead going cold → Creator should re-engage
   - User said "let me think" and hasn't returned

3. **Pricing/details discussed but no closure**
   - Creator shared pricing, user hasn't responded
   - User asked about services, creator replied, conversation stalled

### FOLLOW-UP IS NOT NEEDED (followUp.needed = FALSE) WHEN:

1. **Creator has NEVER replied**
   - Only user messages exist
   - It's just a new/pending conversation, not a "follow-up"

2. **User explicitly declined**
   - "No thanks", "Not interested", "Maybe later", "Not now"
   - User clearly said no → Don't chase

3. **User already converted/enrolled**

4. **Conversation naturally concluded**
   - "Thanks!", "Got it!", "See you!" without pending questions

### PRIORITY LEVELS (only when followUp.needed = TRUE):

- **high**: 
  - Hot lead (leadScore > 0.6) waiting for response
  - User sent "??", "hello?", or multiple unanswered messages
  - User asked direct question about pricing/enrollment

- **medium**: 
  - Moderate interest (leadScore 0.4-0.6)
  - User sent a message that needs response
  - Conversation stalled after creator's reply

- **low**: 
  - Casual inquiry
  - General conversation, lower urgency

### ⚠️ WRITING STYLE FOR "reason" AND "suggestedAction" (VERY IMPORTANT)

Write like a helpful assistant talking directly to the creator. Be warm, concise, and actionable.

❌ BAD (robotic/formal):
- "High-quality lead has provided requested information and is awaiting the creator's next steps."
- "User inquiry requires response from business account holder."
- "Conversation stalled after creator's last message. Re-engagement recommended."

✅ GOOD (friendly/conversational):
- "They shared their details - time to send over your program info! 🎯"
- "Hot lead waiting! They asked about pricing - don't let this one slip away."
- "They went quiet after your last message. A quick check-in could bring them back!"
- "They're interested but haven't decided yet. Maybe share a success story?"
- "They asked a question - a quick reply could convert them!"

Keep it SHORT (under 100 characters ideally), friendly, and actionable.

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
    "reason": "Short, friendly message to the creator (see writing style above)",
    "suggestedAction": "Quick actionable tip (only if needed)"
  }
}

## RULES
- Analyze the FULL conversation, not just the last message
- If user previously showed lead intent, maintain that context
- Be STRICT with leadScore - most inquiries are 0.2-0.5, not 0.6+
- Only give leadScore > 0.6 if user shares SPECIFIC goals or asks HOW TO JOIN
- Set leadQuality based on score: none(0-0.2), low(0.2-0.4), medium(0.4-0.6), high(0.6-0.8), hot(0.8-1.0)
- ⚠️ CRITICAL: followUp.needed can ONLY be true if Creator has sent at least one message
- If Creator has replied AND last message is from User → followUp.needed should usually be TRUE
- If followUp.needed is false, set priority to null and suggestedAction to null
`;

/**
 * Extract JSON from Gemini response
 * Handles truncated responses by extracting partial data
 */
function extractJson(text) {
  if (!text || typeof text !== "string") return null;

  // Try direct JSON match
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // JSON might be truncated, try to extract partial data
      console.log("[Gemini] JSON parse failed, attempting partial extraction...");
    }
  }

  // Try markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // Continue to partial extraction
    }
  }

  // 🔥 PARTIAL EXTRACTION: Try to extract key fields even from truncated JSON
  try {
    const partialData = {};
    
    // Extract intent
    const intentMatch = text.match(/"intent"\s*:\s*"(General|Lead|Business)"/i);
    if (intentMatch) partialData.intent = intentMatch[1];
    
    // Extract confidence
    const confidenceMatch = text.match(/"confidence"\s*:\s*([\d.]+)/);
    if (confidenceMatch) partialData.confidence = parseFloat(confidenceMatch[1]);
    
    // Extract leadScore
    const leadScoreMatch = text.match(/"leadScore"\s*:\s*([\d.]+)/);
    if (leadScoreMatch) partialData.leadScore = parseFloat(leadScoreMatch[1]);
    
    // Extract leadQuality
    const leadQualityMatch = text.match(/"leadQuality"\s*:\s*"(none|low|medium|high|hot)"/i);
    if (leadQualityMatch) partialData.leadQuality = leadQualityMatch[1];
    
    // Extract followUp.needed
    const followUpNeededMatch = text.match(/"needed"\s*:\s*(true|false)/i);
    if (followUpNeededMatch) {
      partialData.followUp = partialData.followUp || {};
      partialData.followUp.needed = followUpNeededMatch[1].toLowerCase() === "true";
    }
    
    // Extract followUp.priority
    const priorityMatch = text.match(/"priority"\s*:\s*"(high|medium|low)"/i);
    if (priorityMatch) {
      partialData.followUp = partialData.followUp || {};
      partialData.followUp.priority = priorityMatch[1];
    }
    
    // If we extracted at least intent, return partial data
    if (partialData.intent) {
      console.log("[Gemini] ⚠️ Using partial extraction:", JSON.stringify(partialData));
      return partialData;
    }
  } catch (e) {
    console.error("[Gemini] Partial extraction failed:", e.message);
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
  const lastSenderIsUser = lastMessage?.sender !== "me";
  
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

  // 🔥 Add critical context about creator participation and last sender
  const contextNote = `

[Conversation State]
- Total messages: ${messages.length}
- Creator has replied in this conversation: ${hasCreatorMessage ? "YES" : "NO"}
- Last message from: ${lastSenderIsUser ? "User" : "Creator"}
- Follow-up eligible: ${hasCreatorMessage ? "YES (creator has engaged)" : "NO (creator hasn't replied yet - not a follow-up situation)"}
${hasCreatorMessage && lastSenderIsUser ? "- ⚠️ User is waiting for Creator's response!" : ""}`;

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

      // 🔥 CRITICAL: Determine follow-up status
      let followUpNeeded = Boolean(parsed.followUp?.needed);
      let followUpReason = parsed.followUp?.reason ? String(parsed.followUp.reason).substring(0, 200) : null;
      let followUpPriority = parsed.followUp?.priority || null;
      let suggestedAction = parsed.followUp?.suggestedAction || null;
      
      // RULE 1: If creator has never replied, follow-up is NOT applicable
      if (!hasCreatorMessage) {
        followUpNeeded = false;
        followUpReason = "Creator hasn't replied yet - this is a new message, not a follow-up situation";
        followUpPriority = null;
        suggestedAction = null;
        console.log(`[Gemini] 🚫 Follow-up disabled: Creator hasn't replied yet`);
      }
      
      // RULE 2: If creator has replied AND last message is from user, follow-up should typically be true
      // (unless user explicitly declined)
      if (hasCreatorMessage && lastSenderIsUser && !followUpNeeded) {
        // Check if Gemini detected a decline
        const declineKeywords = ["not interested", "no thanks", "maybe later", "not now", "no need"];
        const lastMsgText = (lastMessage?.text || "").toLowerCase();
        const isDecline = declineKeywords.some(kw => lastMsgText.includes(kw));
        
        if (!isDecline) {
          // Gemini might have missed it - user sent a message, creator should respond
          console.log(`[Gemini] ⚠️ Override: Creator has replied, last msg from user, setting followUp=true`);
          followUpNeeded = true;
          followUpReason = followUpReason || "User sent a message - creator should respond";
          followUpPriority = followUpPriority || "medium";
          suggestedAction = suggestedAction || "Respond to the user's message";
        }
      }

      const followUp = {
        needed: followUpNeeded,
        priority: followUpNeeded && ["high", "medium", "low"].includes(followUpPriority)
          ? followUpPriority
          : (followUpNeeded ? "medium" : null),
        reason: followUpReason,
        suggestedAction: followUpNeeded ? (suggestedAction ? String(suggestedAction).substring(0, 300) : "Respond to the user") : null,
      };

      console.log(`[Gemini] Intent: ${intent} (${confidence.toFixed(2)}) | LeadScore: ${leadScore.toFixed(2)} (${leadQuality}) | CreatorReplied: ${hasCreatorMessage} | LastMsgFromUser: ${lastSenderIsUser} | FollowUp: ${followUp.needed ? followUp.priority : 'not needed'}`);

      return {
        intent,
        confidence: Number(confidence.toFixed(3)),
        leadScore: Number(leadScore.toFixed(3)),
        leadQuality,
        factors,
        followUp,
        creatorHasReplied: hasCreatorMessage,
        lastSenderIsUser,
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

      // 🔥 Even on error, respect the creatorHasReplied rule
      const lastSenderIsUserFallback = messages[messages.length - 1]?.sender !== "me";
      
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
        lastSenderIsUser: lastSenderIsUserFallback,
        error: true,
      };
    }
  }

  const lastSenderIsUserFallback = messages[messages.length - 1]?.sender !== "me";

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
    lastSenderIsUser: lastSenderIsUserFallback,
    error: true,
  };
}
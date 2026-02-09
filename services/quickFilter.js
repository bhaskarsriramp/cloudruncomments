// services/quickFilter.js

/**
 * Ultra-fast local filter (0ms, no API calls, no cold starts)
 * Filters obvious noise and identifies clear lead/business signals
 * 
 * Returns: { passToGemini: boolean, label: string, confidence: number }
 */
export function quickLocalFilter(messageText) {
  if (!messageText || typeof messageText !== "string") {
    return { passToGemini: false, label: "empty", confidence: 1 };
  }

  const text = messageText.trim();
  const lowerText = text.toLowerCase();

  // ─────────────────────────────────────────────
  // SKIP: Very short messages (1-3 chars)
  // ─────────────────────────────────────────────
  if (text.length <= 3) {
    return { passToGemini: false, label: "too_short", confidence: 1 };
  }

  // ─────────────────────────────────────────────
  // DEFINITE NOISE - Skip Gemini (save cost)
  // ─────────────────────────────────────────────
  const noisePatterns = [
    // Greetings
    /^(hi+|hey+|hello+|helo+|hii+|yo+|hola)$/i,
    /^(hi+|hey+|hello+)\s+(there|bro|sir|mam|madam|bhai|didi)$/i,
    
    // Short responses
    /^(ok+|okay+|k+|okk+|oky+|alright)$/i,
    /^(yes+|no+|yeah+|yep+|nope+|nah+|ya+|na+)$/i,
    /^(sure+|done+|fine+|good+)$/i,
    
    // Gratitude
    /^(thanks+|thank\s*you+|thanku+|thx+|ty+|thnx+|dhanyawad)$/i,
    /^(welcome+|np+|no\s*problem)$/i,
    
    // Time-based greetings
    /^(good\s*morning|good\s*night|good\s*evening|good\s*afternoon|gm+|gn+|morning+|night+)$/i,
    
    // Honorifics only
    /^(bro+|bhai+|sir+|mam+|madam+|dude+|didi+|boss+)$/i,
    
    // Filler sounds
    /^(hmm+|hm+|ahh*|ohh*|umm*|ooh+|aah+)$/i,
    
    // Simple reactions
    /^(nice+|great+|awesome+|cool+|wow+|amazing+|superb+|fantastic+)$/i,
    /^(lol+|haha+|hehe+|lmao+|rofl+)$/i,
    
    // Emoji only (single or multiple)
    /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Emoji_Component}\s]+$/u,
    
    // Punctuation only
    /^[.!?,\-_:;'"()]+$/,
    
    // Single word compliments (not asking anything)
    /^(love\s*it|loved\s*it|beautiful|gorgeous|stunning|handsome|pretty)$/i,
    
    // Story reactions
    /^(replied\s*to\s*your\s*story|reacted\s*to\s*your\s*story)$/i,
  ];

  for (const pattern of noisePatterns) {
    if (pattern.test(lowerText)) {
      return { passToGemini: false, label: "noise", confidence: 0.95 };
    }
  }

  // ─────────────────────────────────────────────
  // SINGLE-WORD KEYWORD MESSAGES → NOT leads
  // Words like "Diet", "Coach", "Transformation" alone
  // are vague/lazy messages, not serious lead signals
  // ─────────────────────────────────────────────
  const wordCount = text.split(/\s+/).length;
  if (wordCount <= 2) {
    const singleWordKeywords = /^(diet|coach|coaching|transformation|fitness|workout|exercise|nutrition|gym|training|plan|program|course|package|batch|slot|session|details|info|following|interested)$/i;
    if (singleWordKeywords.test(lowerText)) {
      return { passToGemini: false, label: "single_keyword_noise", confidence: 0.9 };
    }
    // Also catch 2-word combos like "Get Details", "1:1 Coaching", "Fat Loss"
    const twoWordKeywords = /^(get\s*details|1[:\s]*1\s*coaching|fat\s*loss|weight\s*loss|muscle\s*gain|more\s*info|tell\s*more)$/i;
    if (twoWordKeywords.test(lowerText)) {
      return { passToGemini: false, label: "single_keyword_noise", confidence: 0.85 };
    }
  }

  // ─────────────────────────────────────────────
  // DEFINITE LEAD SIGNALS - Must go to Gemini
  // ─────────────────────────────────────────────
  const leadPatterns = [
    // Pricing inquiries
    /price|pricing|cost|fee|charge|rate|kitna|kya\s*price|paisa|rupee|₹|\$|payment/i,
    
    // Program/service interest
    /program|course|coaching|training|plan|package|batch|slot|session|consultation/i,
    
    // Action intent
    /join|enroll|register|sign\s*up|start|begin|book|apply|admission/i,
    /want\s*to\s*(join|start|begin|try|do)/i,
    /how\s*(to|can\s*i)\s*(join|start|enroll|register|book)/i,
    
    // Fitness goals (Indian fitness market specific)
    /weight\s*loss|fat\s*loss|lose\s*weight|reduce\s*weight/i,
    /muscle\s*gain|bulk|lean|toning|transformation/i,
    /fitness|gym|workout|exercise|diet|nutrition/i,
    /belly\s*fat|body\s*fat|slim|thin|fit/i,
    
    // Specific numbers (weight, duration, etc.)
    /\d+\s*(kg|kgs|pounds|lbs|kilos)/i,
    /\d+\s*(days|weeks|months|years)/i,
    /lose\s*\d+|gain\s*\d+|reduce\s*\d+/i,
    
    // Information requests
    /details|more\s*info|information|tell\s*me\s*more|explain/i,
    /how\s*much|what\s*is\s*the|what\s*are\s*the/i,
    /can\s*you\s*help|need\s*help|guide\s*me/i,
    
    // Contact sharing (strong signal)
    /[6-9]\d{9}/, // Indian phone number
    /\+91\s*\d{10}/, // Indian phone with country code
    /\S+@\S+\.\S+/, // Email
    /whatsapp|call\s*me|contact|reach\s*me|dm\s*me/i,
    
    // Urgency signals
    /urgent|asap|immediately|serious|seriously|genuine|genuinely/i,
    /interested|want|looking\s*for|need|require/i,
    
    // Availability queries
    /available|availability|timing|schedule|when\s*can|slot/i,
    /online|offline|location|where/i,
  ];

  for (const pattern of leadPatterns) {
    if (pattern.test(lowerText)) {
      return { passToGemini: true, label: "lead_signal", confidence: 0.9 };
    }
  }

  // ─────────────────────────────────────────────
  // BUSINESS/COLLABORATION SIGNALS
  // ─────────────────────────────────────────────
  const businessPatterns = [
    /collab|collaboration|collaborate|partner|partnership/i,
    /sponsor|sponsorship|brand\s*deal|promotion|promote/i,
    /influencer|marketing|campaign|ambassador/i,
    /paid\s*promotion|shoutout|feature/i,
    /business\s*proposal|opportunity|offer/i,
  ];

  for (const pattern of businessPatterns) {
    if (pattern.test(lowerText)) {
      return { passToGemini: true, label: "business_signal", confidence: 0.9 };
    }
  }

  // ─────────────────────────────────────────────
  // AMBIGUOUS - Let Gemini decide
  // ─────────────────────────────────────────────
  
  // Long messages (>80 chars) are likely meaningful
  if (text.length > 80) {
    return { passToGemini: true, label: "long_message", confidence: 0.7 };
  }

  // Questions usually need analysis
  if (text.includes("?") && text.length > 10) {
    return { passToGemini: true, label: "question", confidence: 0.75 };
  }

  // Medium length messages (30-80 chars) with some substance
  if (text.length > 30) {
    // Check if it has multiple words (not just one long word)
    const wordCount = text.split(/\s+/).length;
    if (wordCount >= 4) {
      return { passToGemini: true, label: "medium_message", confidence: 0.6 };
    }
  }

  // ─────────────────────────────────────────────
  // DEFAULT: Short ambiguous messages → Skip
  // ─────────────────────────────────────────────
  return { passToGemini: false, label: "short_ambiguous", confidence: 0.7 };
}

/**
 * Get filter statistics for monitoring
 */
export function getFilterLabel(label) {
  const labelMap = {
    empty: "Empty message",
    too_short: "Too short (<4 chars)",
    noise: "Noise (greeting/emoji/reaction)",
    single_keyword_noise: "Single keyword (not a lead)",
    lead_signal: "Lead signal detected",
    business_signal: "Business/collab signal",
    long_message: "Long message (>80 chars)",
    question: "Question detected",
    medium_message: "Medium length message",
    short_ambiguous: "Short ambiguous",
  };
  return labelMap[label] || label;
}
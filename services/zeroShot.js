// services/zeroShot.js
import axios from "axios";

const HF_API_KEY = process.env.HF_API_KEY;
const HF_API_URL = "https://router.huggingface.co/hf-inference/models/facebook/bart-large-mnli";

const LABELS = [
  "greeting_or_salutation",
  "courtesy",
  "automation",
  "flow_trigger",
  "emoji",
  "reaction",
  "compliment",
  "appreciation",
  "gibberish",
  "meaningful_inquiry",
];

const HARD_BLOCK_LABELS = [
  "greeting_or_salutation",
  "emoji",
  "reaction",
  "gibberish",
];

const CONFIDENCE_THRESHOLD = 0.75;

// 🔥 FIXED: Match original retry config for HF cold starts
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;
const REQUEST_TIMEOUT_MS = 120000; // HF can take 60s+ on cold start

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single message HF filter (optimized for real-time)
 */
export async function zeroShotSingleFilter(messageText) {
  if (!messageText || typeof messageText !== "string") {
    return { passToGemini: true, label: "unknown", confidence: 0 }; // 🔥 FIXED typo
  }

  const text = messageText.trim();

  // Quick skip for very short messages
  if (text.length <= 3) {
    return { passToGemini: false, label: "too_short", confidence: 1 }; // 🔥 FIXED typo
  }

  // Fail-open if no API key
  if (!HF_API_KEY) {
    console.warn("[HF] No API key, passing to Gemini");
    return { passToGemini: true, label: "no_api_key", confidence: 0 }; // 🔥 FIXED typo
  }

  let retries = 0;
  let delay = INITIAL_DELAY_MS;

  while (retries < MAX_RETRIES) {
    try {
      console.log(`[HF] Attempt ${retries + 1}/${MAX_RETRIES} for: "${text.substring(0, 50)}..."`);

      const response = await axios.post(
        HF_API_URL,
        {
          inputs: text,
          parameters: { candidate_labels: LABELS },
          options: { wait_for_model: true },
        },
        {
          headers: {
            Authorization: `Bearer ${HF_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: REQUEST_TIMEOUT_MS, // 🔥 FIXED: 120s timeout
        }
      );

      const data = response.data;
      const label = data.labels?.[0] || "unknown";
      const score = data.scores?.[0] || 0;
      
      // Find meaningful_inquiry score safely
      const meaningfulIndex = data.labels?.indexOf("meaningful_inquiry");
      const meaningfulScore = meaningfulIndex >= 0 ? data.scores[meaningfulIndex] : 0;

      // Decision logic
      let passToGemini = true; // 🔥 FIXED typo

      if (HARD_BLOCK_LABELS.includes(label) && score >= 0.8) {
        passToGemini = false;
      } else if (label === "meaningful_inquiry") {
        passToGemini = true;
      } else if (score >= CONFIDENCE_THRESHOLD && meaningfulScore < 0.3) {
        passToGemini = false;
      }

      console.log(`[HF] Result: ${label} (${score.toFixed(2)}) | meaningful: ${meaningfulScore.toFixed(2)} | pass: ${passToGemini}`);

      return {
        passToGemini, // 🔥 FIXED typo
        label,
        confidence: Number(score.toFixed(3)),
        meaningfulScore: Number(meaningfulScore.toFixed(3)),
      };
    } catch (err) {
      retries++;
      const status = err?.response?.status;
      const errMsg = err?.response?.data?.error || err.message;

      console.error(`[HF] Attempt ${retries}/${MAX_RETRIES} failed: ${errMsg}`);

      // Non-recoverable errors → fail open immediately
      if ([400, 401, 403, 422].includes(status)) {
        console.error("[HF] Non-recoverable error, passing to Gemini");
        return { passToGemini: true, label: "hf_error", confidence: 0 }; // 🔥 FIXED typo
      }

      // Max retries exceeded → fail open
      if (retries >= MAX_RETRIES) {
        console.error("[HF] Max retries exceeded, passing to Gemini");
        return { passToGemini: true, label: "max_retries", confidence: 0 }; // 🔥 FIXED typo
      }

      // Wait before retry
      console.log(`[HF] Waiting ${delay}ms before retry...`);
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  // Should never reach here, but fail open
  return { passToGemini: true, label: "unknown", confidence: 0 }; // 🔥 FIXED typo
}
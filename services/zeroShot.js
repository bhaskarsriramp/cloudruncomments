// services/zeroShot.js
import axios from "axios";

const HF_API_KEY = process.env.HF_API_KEY;
const HF_API_URL = "https://router.huggingface.co/hf-inference/models/facebook/bart-large-mnli";

const LABELS = [
  "greeting_or_salutation",
  "courtesy",
  "emoji",
  "reaction",
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
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single message HF filter (optimized for real-time)
 */
export async function zeroShotSingleFilter(messageText) {
  if (!messageText || typeof messageText !== "string") {
    return { passToCgemini: true, label: "unknown", confidence: 0 };
  }

  const text = messageText.trim();

  // Quick skip for very short messages
  if (text.length <= 3) {
    return { passToCgemini: false, label: "too_short", confidence: 1 };
  }

  // Fail-open if no API key
  if (!HF_API_KEY) {
    console.warn("[HF] No API key, passing to Gemini");
    return { passToCgemini: true, label: "no_api_key", confidence: 0 };
  }

  let retries = 0;
  let delay = INITIAL_DELAY_MS;

  while (retries < MAX_RETRIES) {
    try {
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
          timeout: 10000,
        }
      );

      const data = response.data;
      const label = data.labels?.[0] || "unknown";
      const score = data.scores?.[0] || 0;
      const meaningfulScore = data.scores?.[data.labels?.indexOf("meaningful_inquiry")] || 0;

      // Decision logic
      let passToCgemini = true;

      if (HARD_BLOCK_LABELS.includes(label) && score >= 0.8) {
        passToCgemini = false;
      } else if (label === "meaningful_inquiry") {
        passToCgemini = true;
      } else if (score >= CONFIDENCE_THRESHOLD && meaningfulScore < 0.3) {
        passToCgemini = false;
      }

      return {
        passToCgemini,
        label,
        confidence: Number(score.toFixed(3)),
        meaningfulScore: Number(meaningfulScore.toFixed(3)),
      };
    } catch (err) {
      retries++;
      const status = err?.response?.status;

      if ([400, 401, 403, 422].includes(status)) {
        console.error("[HF] Non-recoverable error, passing to Gemini");
        return { passToCgemini: true, label: "hf_error", confidence: 0 };
      }

      if (retries >= MAX_RETRIES) {
        console.error("[HF] Max retries, passing to Gemini");
        return { passToCgemini: true, label: "max_retries", confidence: 0 };
      }

      await sleep(delay);
      delay *= 2;
    }
  }
}
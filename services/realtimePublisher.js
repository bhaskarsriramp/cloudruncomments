// services/realtimePublisher.js
import axios from "axios";

const REALTIME_URL = "http://35.254.191.194:3000";

// Axios instance with optimized settings
const realtimeClient = axios.create({
  baseURL: REALTIME_URL,
  timeout: 8000, // 8 second timeout (increased from 3s)
  proxy: false,
  headers: {
    "Content-Type": "application/json",
  },
  // Disable keep-alive to avoid connection pooling issues
  httpAgent: undefined,
  httpsAgent: undefined,
});

/**
 * Fire-and-forget publish - does NOT block the caller
 * Failures are logged but don't affect the main flow
 */
function fireAndForget(promise, label) {
  promise
    .then(() => {
      // Success - optionally log
    })
    .catch((err) => {
      console.error(`❌ [${label}] Fire-and-forget failed:`, err.message);
    });
}

/**
 * Retry wrapper with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 2, initialDelay = 500) {
  let lastError;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      
      const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
      const isNetworkError = err.code === "ECONNREFUSED" || err.code === "ENOTFOUND";
      
      // Don't retry on non-recoverable errors
      if (!isTimeout && !isNetworkError && err.response?.status < 500) {
        throw err;
      }

      if (attempt < maxRetries) {
        console.warn(`⚠️ Retry ${attempt}/${maxRetries} after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2; // Exponential backoff
      }
    }
  }

  throw lastError;
}

/**
 * Publish new message to inbox (fire-and-forget)
 * This should NEVER block webhook processing
 */
export function publishInboxMessageHTTP({
  creatorId,
  conversationId,
  message,
  conversation,
}) {
  // Fire and forget - don't await
  fireAndForget(
    realtimeClient.post("/publish/inbox", {
      creatorId,
      conversationId,
      message,
      conversation,
    }),
    "inbox-message"
  );
}

/**
 * Publish conversation update (label, followUp, etc.)
 * Fire-and-forget with internal retry
 */
export function publishConversationUpdate({
  creatorId,
  conversationId,
  update,
}) {
  // Fire and forget with retry
  fireAndForget(
    retryWithBackoff(
      () =>
        realtimeClient.post("/publish/conversation-update", {
          creatorId,
          conversationId,
          update,
        }),
      2, // 2 retries
      300 // 300ms initial delay
    ).then(() => {
      console.log(`✅ Published conversation update for: ${conversationId}`);
    }),
    "conversation-update"
  );
}

/**
 * Publish new conversation creation (fire-and-forget)
 */
export function publishConversationCreated({ creatorId, conversation }) {
  const payload = {
    creatorId: String(creatorId),
    conversation: conversation,
  };

  // Fire and forget with retry
  fireAndForget(
    retryWithBackoff(
      () => realtimeClient.post("/publish/conversation-created", payload),
      2,
      300
    ).then(() => {
      console.log("✅ Published conversation:created to creator room");
    }),
    "conversation-created"
  );
}

/**
 * BLOCKING version - use only when you NEED to wait for result
 * Example: When the response depends on publish success
 */
export async function publishInboxMessageHTTPBlocking({
  creatorId,
  conversationId,
  message,
  conversation,
}) {
  try {
    await retryWithBackoff(
      () =>
        realtimeClient.post("/publish/inbox", {
          creatorId,
          conversationId,
          message,
          conversation,
        }),
      3, // 3 retries for blocking calls
      500
    );
    return { success: true };
  } catch (err) {
    console.error("❌ Blocking inbox publish failed:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Health check for realtime server
 */
export async function checkRealtimeHealth() {
  try {
    const res = await realtimeClient.get("/health", { timeout: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}
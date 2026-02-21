// services/rateLimiter.js
// Rate limiting via the Redis bridge VM (http calls) — no direct ioredis needed.
import axios from "axios";

const BRIDGE_URL = "http://34.180.49.15:3000";
const WAIT_INTERVALS_MS = [15000, 35000, 60000, 90000, 120000];

const bridgeClient = axios.create({
  baseURL: BRIDGE_URL,
  timeout: 5000,
  proxy: false,
  headers: { "Content-Type": "application/json" },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls the bridge /ratelimit/check endpoint which runs the atomic Lua script on Redis.
// Returns true if a slot was granted, false if rate limited.
// Fails open if the bridge is unreachable — prefer sending over blocking.
export async function canSendDM(creatorId) {
  try {
    const { data } = await bridgeClient.post("/ratelimit/check", {
      creatorId: String(creatorId),
    });
    return data.allowed === true;
  } catch (err) {
    console.error(`[RateLimit] Bridge unavailable for creator ${creatorId}, failing open:`, err.message);
    return true;
  }
}

// Waits through intervals and retries canSendDM until a slot opens or all intervals are exhausted.
// Returns true if a slot was eventually granted, false if still rate limited after full wait.
export async function waitForDMSlot(creatorId) {
  try {
    for (const intervalMs of WAIT_INTERVALS_MS) {
      await sleep(intervalMs);
      console.log(`[RateLimit] Retrying slot for creator ${creatorId} after ${intervalMs}ms`);
      const allowed = await canSendDM(creatorId);
      if (allowed) {
        console.log(`[RateLimit] Slot acquired for creator ${creatorId}`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error(`[RateLimit] waitForDMSlot error for creator ${creatorId}, failing open:`, err.message);
    return true;
  }
}

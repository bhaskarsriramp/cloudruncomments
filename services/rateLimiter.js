// services/rateLimiter.js
import redis from "./redis.js";

const RATE_LIMIT_PER_HOUR = 180;
const WINDOW_MS = 3600000; // 1 hour in ms
const WAIT_INTERVALS_MS = [15000, 35000, 60000, 90000, 120000];

// Atomic Lua script: remove expired entries → count → conditionally add
// Only ZADD (consume a slot) if count is under the limit
const ROLLING_WINDOW_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]

  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  local count = redis.call('ZCARD', key)

  if count < limit then
    redis.call('ZADD', key, now, member)
    redis.call('EXPIRE', key, 7200)
    return 1
  end

  redis.call('EXPIRE', key, 7200)
  return 0
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atomically checks the rolling window and consumes a slot if available.
// Returns true if a slot was granted, false if rate limited.
// Fails open (returns true) if Redis is unreachable — prefer sending over blocking.
export async function canSendDM(creatorId) {
  const key = `rl:${creatorId}`;
  const now = Date.now();
  const member = `${now}:${Math.random().toString(36).substring(2, 11)}`;

  try {
    const result = await redis.eval(
      ROLLING_WINDOW_SCRIPT,
      1,
      key,
      String(now),
      String(WINDOW_MS),
      String(RATE_LIMIT_PER_HOUR),
      member
    );
    return result === 1;
  } catch (err) {
    console.error(`[RateLimit] Redis unavailable for creator ${creatorId}, failing open:`, err.message);
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

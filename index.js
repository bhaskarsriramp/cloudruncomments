// index.js for cloudruncomments service - PUBSUB PROCESSOR ONLY
import express from "express";
import mongoose from "mongoose";
import axios from "axios";
import qs from "qs";
import crypto from "crypto";
import Automation from "./models/Automation.js";
import RepliedComment from "./models/RepliedComment.js";
import User from "./models/User.js";
import ActionLock from "./models/ActionLock.js";
import ProcessedEvent from "./models/ProcessedEvent.js";
import ConversationState from "./models/ConversationState.js";
import { persistInboxMessage } from "./services/inboxPersistence.js";
import { publishInboxMessageHTTP, publishConversationUpdate } from "./services/realtimePublisher.js";
import levenshtein from "fast-levenshtein";
import agenda from "./services/agenda.js";
import instagramService from "./services/instagramService.js";
import { findOrCreateConversationByParticipant } from "./services/conversationDiscovery.js";
import { detectLeadRealtime } from "./services/leadDetectionService.js";
import { generateQuickReplies } from "./services/quickRepliesService.js";
import { canSendDM, waitForDMSlot } from "./services/rateLimiter.js";
import { encryptToken, decryptUserTokens } from "./utils/tokenCrypto.js";

// Safety net: a DB auth/network error can surface as an unhandled 'error'
// event or rejection deep in the MongoDB driver's connection pool, outside
// any try/catch here. Left unhandled, Node treats that as fatal and kills
// the whole Cloud Run container — taking down every in-flight request over
// one bad connection attempt. Log and keep the process alive instead.
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException (process kept alive):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection (process kept alive):", err?.message || err);
});

const app = express();
app.use(express.json({ type: "*/*" }));

// Config
const PORT = 8080;
const PUBSUB_TOKEN = process.env.PUBSUB_TOKEN || "";
const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const FB_API = "https://graph.facebook.com/v24.0";
const DAY_MS = 24 * 60 * 60 * 1000;

const db_username = process.env.MONGO_DB_USER;
const db_password = process.env.MONGO_DB_PASS;

var MONGO_URI = 'mongodb+srv://'+db_username+':'+db_password+'@cluster0.ds8pal0.mongodb.net/?appName=Cluster0';

// ---------- Axios setup ----------
const http = axios.create({
  timeout: 15000,
  validateStatus: (s) => s >= 200 && s < 500,
});

http.interceptors.response.use(
  (r) => r,
  (e) => {
    const cfg = e.config || {};
    const urlWithQuery = cfg.url + (cfg.params ? `?${qs.stringify(cfg.params)}` : "");
    const body = e.response?.data || { message: e.message };
    console.error("[HTTP ERROR]", urlWithQuery, JSON.stringify(body, null, 2));
    return Promise.reject(e);
  }
);

// ---------- MongoDB ----------
// Without this listener, a connection error (bad auth, network blip, Atlas
// failover) is an unhandled 'error' event on the connection EventEmitter,
// which crashes the whole process instead of just failing the one request.
mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err.message);
});

async function connectMongo() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    });
  }
}



async function reserveAction({ automationId, postId, igUserId, commentText, commentId, channel }) {
  const now = new Date();
  const textHash = crypto.createHash('md5').update(commentText || '').digest('hex');
  
  try {
    // Attempt to create a NEW lock document with state "reserved"
    // This will FAIL if a document already exists (due to unique index)
    const newLock = await ActionLock.create({
      automationId,
      postId,
      igUserId,
      textHash,
      commentId,
      channel,
      state: "reserved",
      reservedAt: now,
    });

    console.log(`✅ Lock acquired for ${channel}:`, commentId);
    return { proceed: true, lockId: newLock._id };

    
  } catch (err) {
    // Duplicate key error (E11000) means lock already exists
    if (err.code === 11000) {
      console.log(`ℹ️ Action already processed for ${channel}:`, commentId);
      return { proceed: false };
    }
    
    // Other errors should be logged and block the action
    console.error("❌ reserveAction error:", err.message);
    return { proceed: false };
  }
}

async function finalizeAction({ automationId, postId, igUserId, commentText, commentId, channel, ok, error }) {
  const textHash = crypto.createHash('md5').update(commentText || '').digest('hex');
  
  try {
    const update = {
      state: ok ? "sent" : "failed",
      sentAt: ok ? new Date() : null,
      error: error || null,
    };

    const result = await ActionLock.updateOne(
      { 
        automationId, 
        postId, 
        igUserId, 
        textHash, 
        channel, 
        commentId,
        state: "reserved" // Only update if still in reserved state
      },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      console.warn(`⚠️ No reserved lock found to finalize for ${channel}:`, commentId);
    } else {
      console.log(`✅ Lock finalized for ${channel}:`, commentId, ok ? "SUCCESS" : "FAILED");
    }
    
  } catch (err) {
    console.error("❌ finalizeAction error:", err.message);
  }
}


/**
 * Comment automation for a single Meta webhook "comments" change.
 * Scope: keyword-triggered public reply + one private "reply to comment" DM,
 * using Automation.replyComments / Automation.dmMessage as configured.
 *
 * NOT implemented here: multi-step Automation.flowNodes sequences (branching
 * DM flows via ConversationState) — that's a separate flow-interpreter engine
 * whose JSON shape isn't something this pass has visibility into; building it
 * blind would be guessing at a schema. This handles the single-shot case the
 * service is actually named for.
 */
async function handleCommentChange({ igUserId, value }) {
  const commentId = value?.id;
  const commentText = value?.text || "";
  const commenterId = value?.from?.id;
  const commenterUsername = value?.from?.username;
  const mediaId = value?.media?.id;

  if (!commentId || !mediaId || !commenterId) {
    console.warn("⚠️ Comment webhook missing required fields, skipping:", value);
    return;
  }

  // Don't react to the business's own comments/replies (avoids echo loops).
  if (commenterId === igUserId) return;

  const user = await User.findOne({ igUserId }).lean();
  if (!user) {
    console.warn(`⚠️ No user found for igUserId ${igUserId}`);
    return;
  }
  decryptUserTokens(user);

  const automation = await Automation.findOne({
    userId: user._id,
    postId: mediaId,
    platform: "instagram",
    status: "active",
  });
  if (!automation) return; // nothing configured for this post
  if (automation.postLive === false) return;

  // Keyword match — case-insensitive substring. No keywords configured means
  // any comment on this post triggers it.
  const keywords = (automation.keywords || [])
    .map((k) => String(k).toLowerCase().trim())
    .filter(Boolean);
  const textLower = commentText.toLowerCase();
  const matched = keywords.length === 0 || keywords.some((k) => textLower.includes(k));
  if (!matched) return;

  const pageAccessToken = user.fbPageAccessToken;
  const fbPageId = user.fbPageId;
  if (!pageAccessToken || !fbPageId) {
    console.warn(`⚠️ User ${user._id} has no Facebook Page token/id — cannot execute automation`);
    return;
  }

  let sentMessageText = null;
  let hadFailure = false;

  // ---------- Public reply comment ----------
  if (automation.hasReply && automation.replyComments?.length > 0) {
    const { proceed } = await reserveAction({
      automationId: automation._id,
      postId: mediaId,
      igUserId,
      commentText,
      commentId,
      channel: "public",
    });

    if (proceed) {
      const replyText =
        automation.replyComments[Math.floor(Math.random() * automation.replyComments.length)];
      try {
        await instagramService.replyToComment({
          commentId,
          accessToken: pageAccessToken,
          message: replyText,
        });
        sentMessageText = replyText;
        await finalizeAction({
          automationId: automation._id, postId: mediaId, igUserId, commentText, commentId,
          channel: "public", ok: true,
        });
      } catch (err) {
        hadFailure = true;
        await finalizeAction({
          automationId: automation._id, postId: mediaId, igUserId, commentText, commentId,
          channel: "public", ok: false, error: err.message,
        });
      }
    }
  }

  // ---------- Private "reply to comment" DM ----------
  // Uses Meta's private-reply mechanism (recipient.comment_id) — a one-time
  // DM tied to this specific comment, not a normal recipient.id send, and not
  // subject to the standard 24h messaging window.
  if (automation.dmMessage) {
    const { proceed } = await reserveAction({
      automationId: automation._id,
      postId: mediaId,
      igUserId,
      commentText,
      commentId,
      channel: "private",
    });

    if (proceed) {
      let slotOk = await canSendDM(user._id);
      if (!slotOk) slotOk = await waitForDMSlot(user._id);

      if (!slotOk) {
        hadFailure = true;
        await finalizeAction({
          automationId: automation._id, postId: mediaId, igUserId, commentText, commentId,
          channel: "private", ok: false, error: "rate_limited",
        });
      } else {
        try {
          await instagramService.sendMessage({
            pageId: fbPageId,
            accessToken: pageAccessToken,
            payload: {
              recipient: { comment_id: commentId },
              message: { text: automation.dmMessage },
            },
          });
          sentMessageText = automation.dmMessage;
          await finalizeAction({
            automationId: automation._id, postId: mediaId, igUserId, commentText, commentId,
            channel: "private", ok: true,
          });
        } catch (err) {
          hadFailure = true;
          await finalizeAction({
            automationId: automation._id, postId: mediaId, igUserId, commentText, commentId,
            channel: "private", ok: false, error: err.message,
          });
        }
      }
    }
  }

  await RepliedComment.create({
    commentId,
    automationId: automation._id,
    postId: mediaId,
    userId: user._id,
    text: commentText,
    sentMessage: sentMessageText,
    igUserId: commenterId,
    username: commenterUsername,
    status: hadFailure && !sentMessageText ? "failed" : "replied",
  }).catch((err) => {
    if (err.code !== 11000) console.error("⚠️ RepliedComment.create failed:", err.message);
  });

  await Automation.updateOne(
    { _id: automation._id },
    { $inc: { repliedCount: 1 }, $set: { lastCheckedAt: new Date() } }
  );
}

app.post("/pubsub-messaging", async (req, res) => {
  // Lightweight shared-secret check — configure the push subscription's
  // endpoint as `<service-url>/pubsub-messaging?token=<PUBSUB_TOKEN>`.
  // Skipped entirely if PUBSUB_TOKEN isn't set (matches this app's existing
  // fail-open pattern elsewhere, e.g. rateLimiter's bridge-unavailable case).
  if (PUBSUB_TOKEN && req.query.token !== PUBSUB_TOKEN) {
    return res.status(403).send("forbidden");
  }

  try {
    await connectMongo();

    const pubsubMessage = req.body?.message;
    if (!pubsubMessage?.data) {
      console.warn("⚠️ /pubsub-messaging: no message.data in request body");
      return res.status(200).send("ignored: no message data");
    }

    // Idempotency — Pub/Sub push can redeliver the same message more than
    // once. Skip anything we've already processed.
    const messageId = pubsubMessage.messageId || pubsubMessage.message_id;
    if (messageId) {
      try {
        await ProcessedEvent.create({ eventId: `pubsub:${messageId}` });
      } catch (err) {
        if (err.code === 11000) {
          console.log(`ℹ️ Pub/Sub message ${messageId} already processed, skipping`);
          return res.status(200).send("duplicate");
        }
        throw err;
      }
    }

    let payload;
    try {
      const decoded = Buffer.from(pubsubMessage.data, "base64").toString("utf8");
      payload = JSON.parse(decoded);
    } catch (err) {
      console.error("❌ Failed to decode/parse Pub/Sub message data:", err.message);
      // Ack anyway — a malformed message will never parse on retry either,
      // and Pub/Sub would otherwise redeliver it forever.
      return res.status(200).send("ignored: bad payload");
    }

    // automatic-comment-replies wraps the raw Meta webhook body rather than
    // forwarding it as-is: { receivedAt, eventType, headers, body: { object, entry } }.
    // Comments and DMs go to separate Pub/Sub topics (ig-webhook-events /
    // ig-messaging-events) based on payload.eventType, but both land here if
    // both topics' push subscriptions point at this endpoint — eventType lets
    // us ignore anything that isn't a comment event without guessing from shape.
    if (payload?.eventType && payload.eventType !== "comment") {
      console.log(`ℹ️ Ignoring non-comment eventType: ${payload.eventType}`);
      return res.status(200).send("ignored: not a comment event");
    }

    const entries = payload?.body?.entry || [];
    for (const entry of entries) {
      const entryIgUserId = entry.id;
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== "comments") continue; // scope: comment automation only
        await handleCommentChange({ igUserId: entryIgUserId, value: change.value || {} }).catch(
          (err) => console.error("❌ handleCommentChange error:", err.message)
        );
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("❌ /pubsub-messaging fatal error:", err.message);
    // Still ack — a poison message would otherwise retry indefinitely.
    return res.status(200).send("error-acked");
  }
});


// Health check
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Start server — bind the port immediately (Cloud Run needs this fast), then
// warm the Mongo connection in the background so it's likely ready by the
// time the first real request lands. /pubsub-messaging also connects lazily
// per-request as a safety net (mongoose.connect no-ops if already connected).
app.listen(PORT, () => {
  console.log(`🚀 Pub/Sub processor listening on port ${PORT} at ${new Date().toISOString()}`);
  connectMongo().catch((err) => console.error("❌ Initial Mongo connect failed:", err.message));
});
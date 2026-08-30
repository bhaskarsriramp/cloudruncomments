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
import ConversationState from "./models/ConversationState.js";
import { persistInboxMessage } from "./services/inboxPersistence.js";
import { publishInboxMessageHTTP, publishConversationUpdate } from "./services/realtimePublisher.js";
import levenshtein from "fast-levenshtein";
import agenda from "./services/agenda.js";
import { findOrCreateConversationByParticipant } from "./services/conversationDiscovery.js";
import { detectLeadRealtime } from "./services/leadDetectionService.js";
import { generateQuickReplies } from "./services/quickRepliesService.js";
import { canSendDM, waitForDMSlot } from "./services/rateLimiter.js";
import { encryptToken, decryptUserTokens } from "./utils/tokenCrypto.js";

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


app.post("/pubsub-messaging", async (req, res) => {

});


// Health check
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Pub/Sub processor listening on port ${PORT} at ${new Date().toISOString()}`);
});
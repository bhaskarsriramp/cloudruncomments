// services/conversationDiscovery.js
import axios from "axios";
import Conversation from "../models/Conversation.js";
import Participant from "../models/Participant.js";
import Message from "../models/Message.js";
import instagramService from "./instagramService.js";
import { publishConversationCreated } from "./realtimePublisher.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v24.0";

// 🔥 In-memory lock to prevent concurrent conversation creation for same participant
const conversationCreationLocks = new Map();

/**
 * 🔥 HELPER: Recalculate unread count & reply status from DB
 * Ensures strict consistency between stored Messages and Conversation state
 */
async function recalculateConversationMetrics(conversationId) {
  const messages = await Message.find({
    conversationId,
    isDeleted: false,
  })
    .sort({ createdAtPlatform: -1 }) // Newest first
    .lean();

  if (messages.length === 0) {
    // Safety check for empty conversation
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: {
          unreadCount: 0,
          creatorHasReplied: false,
          lastParticipantMessageAt: null,
        },
      }
    );
    return await Conversation.findById(conversationId);
  }

  // Find creator's latest message timestamp
  let creatorLatestMessageTime = null;
  for (const m of messages) {
    if (m.sender === "me") {
      creatorLatestMessageTime = new Date(m.createdAtPlatform);
      break; 
    }
  }

  let unreadCount = 0;
  let lastParticipantMessageAt = null;

  // Count user messages newer than creator's latest message
  for (const m of messages) {
    if (m.sender === "them") {
      const msgTime = new Date(m.createdAtPlatform);
      
      if (!lastParticipantMessageAt) {
        lastParticipantMessageAt = msgTime;
      }
      
      // 🔥 FIX: Use >= to catch messages in the same second
      if (!creatorLatestMessageTime || msgTime >= creatorLatestMessageTime) {
        unreadCount++;
      }
    }
  }

  const creatorHasReplied = messages.some((m) => m.sender === "me");

  // Update DB and return the fresh document
  const updatedConv = await Conversation.findByIdAndUpdate(
    conversationId,
    {
      $set: {
        unreadCount,
        creatorHasReplied,
        lastParticipantMessageAt,
      },
    },
    { new: true }
  );

  console.log(`📊 [Discovery Recalc] Conv ${conversationId}: unread=${unreadCount}, creatorReplied=${creatorHasReplied}`);
  return updatedConv;
}

/**
 * Acquire a lock for conversation creation
 * Returns a release function if lock acquired, null if already locked
 */
function acquireConversationLock(key) {
  if (conversationCreationLocks.has(key)) {
    console.log(`🔒 Lock already held for: ${key}`);
    return null;
  }
  
  conversationCreationLocks.set(key, Date.now());
  console.log(`🔓 Lock acquired for: ${key}`);
  
  // Auto-release after 30 seconds (safety net)
  const timeout = setTimeout(() => {
    conversationCreationLocks.delete(key);
    console.log(`🔓 Lock auto-released for: ${key}`);
  }, 30000);
  
  return () => {
    clearTimeout(timeout);
    conversationCreationLocks.delete(key);
    console.log(`🔓 Lock released for: ${key}`);
  };
}

/**
 * Wait for lock to be released (with timeout)
 */
async function waitForLock(key, maxWaitMs = 10000) {
  const startTime = Date.now();
  
  while (conversationCreationLocks.has(key)) {
    if (Date.now() - startTime > maxWaitMs) {
      console.log(`⏰ Lock wait timeout for: ${key}`);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return true;
}

/**
 * Find or create a conversation when we only know the participant's IG User ID
 * This happens when a message arrives for a conversation not yet in our DB
 * * 🔥 INCLUDES LOCK MECHANISM to prevent duplicate conversations
 * 🔥 INCLUDES creatorHasReplied tracking via recalculation
 */
export async function findOrCreateConversationByParticipant({
  creatorId,
  participantIgUserId,
  businessIgUserId,
  pageAccessToken,
  fbPageId,
}) {
  // 🔥 Create unique lock key for this creator + participant combination
  const lockKey = `conv:${creatorId}:${participantIgUserId}`;
  
  try {
    console.log("🔍 Searching for conversation with participant:", participantIgUserId);

    // ✅ ALWAYS use standardized igConversationId format
    const igConversationId = `igdm:${businessIgUserId}:${participantIgUserId}`;

    // STEP 1: Check if conversation already exists with this exact ID
    let conversation = await Conversation.findOne({
      creatorId: creatorId,
      platform: "instagram",
      igConversationId: igConversationId,
    });

    if (conversation) {
      console.log("✅ Found existing conversation:", conversation._id);
      
      const participant = await Participant.findById(conversation.participantId);
      
      return {
        conversation: conversation,
        participant: participant,
        isNew: false,
      };
    }

    // 🔥 STEP 1.5: Try to acquire lock before creating new conversation
    const releaseLock = acquireConversationLock(lockKey);
    
    if (!releaseLock) {
      // Lock is held by another request - wait for it
      console.log("⏳ Waiting for another request to finish creating conversation...");
      const lockReleased = await waitForLock(lockKey, 15000);
      
      if (lockReleased) {
        // Lock released - check if conversation was created by other request
        conversation = await Conversation.findOne({
          creatorId: creatorId,
          platform: "instagram",
          igConversationId: igConversationId,
        });
        
        if (conversation) {
          console.log("✅ Conversation was created by concurrent request:", conversation._id);
          const participant = await Participant.findById(conversation.participantId);
          return {
            conversation: conversation,
            participant: participant,
            isNew: false,
          };
        }
      }
      
      // If still no conversation and lock timed out, throw error
      throw new Error("Concurrent conversation creation conflict - please retry");
    }

    try {
      // 🔥 STEP 1.6: Double-check after acquiring lock (another request might have created it)
      conversation = await Conversation.findOne({
        creatorId: creatorId,
        platform: "instagram",
        igConversationId: igConversationId,
      });

      if (conversation) {
        console.log("✅ Conversation was created while waiting for lock:", conversation._id);
        const participant = await Participant.findById(conversation.participantId);
        return {
          conversation: conversation,
          participant: participant,
          isNew: false,
        };
      }

      // STEP 2: No conversation exists - need to fetch from Meta and create

      // STEP 2a: Find the Meta conversation ID (needed for fetching messages)
      console.log("📡 Finding conversation in Meta API...");
      const metaConversationId = await findConversationIdFromMeta({
        businessIgUserId,
        participantIgUserId,
        pageAccessToken,
        fbPageId,
      });

      if (!metaConversationId) {
        throw new Error("Could not find conversation ID from Meta");
      }

      console.log("✅ Found Meta conversation ID:", metaConversationId);

      // STEP 3: Fetch participant profile from Meta
      console.log("👤 Fetching participant profile...");
      const profileData = await instagramService.fetchUserProfile({
        igUserId: participantIgUserId,
        accessToken: pageAccessToken,
      });

      // STEP 4: Create or update participant
      const participant = await Participant.findOneAndUpdate(
        { platform: "instagram", igUserId: participantIgUserId },
        {
          $set: {
            username: profileData?.username || null,
            name: profileData?.name || null,
            profilePic: profileData?.profile_pic_url || null,
            lastSeenAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      console.log("✅ Participant created/updated:", participant._id);

      // STEP 5: Fetch last 25 messages from Meta using the Meta conversation ID
      console.log("📥 Fetching last 25 messages...");
      const { messages: fetchedMessages, paging } =
        await instagramService.fetchLatestMessages({
          igConversationId: metaConversationId, // ✅ Use Meta ID for API calls
          accessToken: pageAccessToken,
          limit: 25,
        });

      console.log(`✅ Fetched ${fetchedMessages.length} messages`);

      // STEP 6: Create conversation record with standardized ID
      // Note: We initialize with defaults here; recalculateConversationMetrics will fix counts later
      const lastMessage = buildLastMessageSnapshot(
        fetchedMessages[0],
        businessIgUserId
      );

      // 🔥 ATOMIC CREATION: Use findOneAndUpdate with upsert to prevent duplicates
      conversation = await Conversation.findOneAndUpdate(
        {
          // Match criteria - prevents duplicates
          creatorId: creatorId,
          platform: "instagram",
          igConversationId: igConversationId,
        },
        {
          $setOnInsert: {
            platform: "instagram",
            igConversationId: igConversationId,     // igdm:17841402138259768:2226812364460274
            metaThreadId: metaConversationId,       // aWdfZAG06MTpJR01lc3NhZA2VU...
            creatorId: creatorId,
            participantId: participant._id,
            lastMessage: lastMessage,
            lastActivityAt: new Date(fetchedMessages[0]?.created_time || Date.now()),
            lastSyncedAt: new Date(),
            lastMetaCursor: paging?.cursors?.after || null,
            unreadCount: 0, // Placeholder
            lastParticipantMessageAt: null, // Placeholder
            creatorHasReplied: false, // Placeholder
            label: "General",
            labelSource: "auto",
          }
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      console.log("✅ Conversation created/found:", conversation._id);
      await conversation.populate('participantId');

      // STEP 7: Save all fetched messages
      console.log("💾 Saving messages to database...");
      const savedMessages = await saveMessagesToDatabase({
        messages: fetchedMessages,
        conversationId: conversation._id,
        participantId: participant._id,
        creatorId: creatorId,
        businessIgUserId: businessIgUserId,
      });

      console.log(`✅ Saved ${savedMessages.length} messages`);

      // 🔥 STEP 8: RECALCULATE METRICS (The Fix)
      // Now that messages are saved, calculate the TRUE state
      const finalConversation = await recalculateConversationMetrics(conversation._id);

      // 🔥 Publish to Redis so frontend gets the new conversation
      await publishConversationCreated({
        creatorId: creatorId,
        conversation: {
          ...finalConversation.toObject(),
          participant: participant.toObject ? participant.toObject() : participant,
          // Calculate if reply window is open
          canReply: finalConversation.lastParticipantMessageAt 
            ? (Date.now() - new Date(finalConversation.lastParticipantMessageAt).getTime() <= 24 * 60 * 60 * 1000)
            : false,
          unreadCount: finalConversation.unreadCount, // From recalculated
          creatorHasReplied: finalConversation.creatorHasReplied, // From recalculated
        },
      });

      console.log("✅ Published new conversation to Redis");

      return {
        conversation: finalConversation, // Return the recalculated conversation
        participant,
        messages: savedMessages,
        isNew: true,
      };
      
    } finally {
      // 🔥 Always release the lock
      releaseLock();
    }
    
  } catch (error) {
    console.error("❌ findOrCreateConversationByParticipant failed:", error.message);
    throw error;
  }
}

/**
 * Find the Instagram Conversation ID by searching through the creator's conversations
 * Returns the Meta conversation ID (needed for API calls to fetch messages)
 */
async function findConversationIdFromMeta({
  businessIgUserId,
  participantIgUserId,
  pageAccessToken,
  fbPageId,
}) {
  try {
    let after = null;
    let attempts = 0;
    const maxAttempts = 5; // Check up to 50 conversations (5 pages × 10)

    while (attempts < maxAttempts) {
      const { data, paging } = await instagramService.fetchConversations({
        pageId: fbPageId, // ✅ Use FB Page ID
        accessToken: pageAccessToken,
        limit: 10,
        after: after,
      });

      // Search through this page of conversations
      for (const conv of data) {
        const participants = conv.participants?.data || [];
        
        // Check if this conversation includes our target participant
        const hasParticipant = participants.some(
          (p) => p.id === participantIgUserId
        );

        if (hasParticipant) {
          console.log("✅ Found Meta conversation ID:", conv.id);
          return conv.id; // Return the Meta conversation ID
        }
      }

      // Check if there are more pages
      if (!paging?.next) {
        break;
      }

      after = paging.cursors?.after;
      attempts++;
    }

    console.warn("⚠️ Conversation not found in first 50 conversations");
    return null;
  } catch (error) {
    console.error("❌ findConversationIdFromMeta error:", error.message);
    throw error;
  }
}

/**
 * Build last message snapshot for conversation
 */
function buildLastMessageSnapshot(message, businessIgUserId) {
  if (!message) {
    return {
      text: "No messages yet",
      type: "system",
      sender: "them",
      timestamp: new Date(),
    };
  }

  const isFromBusiness = message.from?.id === businessIgUserId;
  let type = "text";
  let text = message.message || "";

  // Handle attachments
  if (message.attachments && message.attachments.length > 0) {
    const attachment = message.attachments[0];
    if (attachment.image_data) {
      type = "image";
      text = "Sent an image";
    } else if (attachment.video_data) {
      type = "video";
      text = "Sent a video";
    }
  }

  // Handle unsupported content
  if (message.is_unsupported) {
    type = "system";
    text = "Shared unsupported content";
  }

  return {
    text: text || "Sent an attachment",
    type: type,
    sender: isFromBusiness ? "me" : "them",
    timestamp: new Date(message.created_time),
  };
}

/**
 * Save messages to database in bulk
 */
async function saveMessagesToDatabase({
  messages,
  conversationId,
  participantId,
  creatorId,
  businessIgUserId,
}) {
  try {
    const messageDocs = messages.map((msg) => {
      const isFromBusiness = msg.from?.id === businessIgUserId;
      
      let type = "text";
      let text = msg.message || null;
      let mediaUrl = null;
      let mediaType = null;
      let action = null;

      // Handle attachments
      if (msg.attachments && msg.attachments.length > 0) {
        const attachment = msg.attachments[0];
        
        if (attachment.image_data) {
          type = "image";
          mediaType = "image";
          mediaUrl = attachment.image_data?.url || attachment.file_url;
        } else if (attachment.video_data) {
          type = "video";
          mediaType = "video";
          mediaUrl = attachment.video_data?.url || attachment.file_url;
        }
      }

      // Handle unsupported content
      if (msg.is_unsupported) {
        type = "system";
        text = "Shared unsupported content";
        action = {
          label: "View on Instagram",
          url: "https://www.instagram.com/direct/inbox/",
        };
      }

      return {
        conversationId: conversationId,
        platform: "instagram",
        igMessageId: msg.id,
        sender: isFromBusiness ? "me" : "them",
        senderType: isFromBusiness ? "creator" : "participant",
        senderId: isFromBusiness ? creatorId : participantId,
        senderTypeRef: isFromBusiness ? "users" : "participants",
        type: type,
        text: text,
        mediaUrl: mediaUrl,
        mediaType: mediaType,
        action: action,
        isRead: isFromBusiness, // Creator's own messages are always read
        createdAtPlatform: new Date(msg.created_time),
      };
    });

    // Insert messages, ignoring duplicates
    const result = await Message.insertMany(messageDocs, { ordered: false });
    return result;
  } catch (error) {
    // If error is duplicate key, some messages were already saved - that's OK
    if (error.code === 11000) {
      console.log("ℹ️ Some messages already exist (duplicate key), continuing...");
      return [];
    }
    throw error;
  }
}
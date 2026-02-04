// services/inboxPersistence.js
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Participant from "../models/Participant.js";

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
    return { unreadCount: 0, creatorHasReplied: false, lastParticipantMessageAt: null };
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

  // Update the conversation with the recalculated values
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

  console.log(
    `📊 [recalculateMetrics] Conv ${conversationId}: unread=${unreadCount}, creatorReplied=${creatorHasReplied}`
  );

  return updatedConv;
}

export async function persistInboxMessage({
  creatorId,
  businessIgUserId,
  senderIgUserId,
  igMessageId,

  type,
  text,
  mediaUrl,
  mediaType,
  action,

  createdAt,
  skipIfNoConversation = false, // NEW FLAG for discovery flow
}) {
  // =========================================================
  // 1️⃣ Ensure participant exists
  // =========================================================
  const participant = await Participant.findOneAndUpdate(
    { platform: "instagram", igUserId: senderIgUserId },
    { $setOnInsert: { platform: "instagram", igUserId: senderIgUserId } },
    { upsert: true, new: true }
  );

  const igConversationId = `igdm:${businessIgUserId}:${senderIgUserId}`;

  // =========================================================
  // 2️⃣ Find existing conversation
  // =========================================================
  let conversation = await Conversation.findOne({
    creatorId,
    platform: "instagram",
    igConversationId,
  });

  // =========================================================
  // 🔥 NEW: If conversation doesn't exist and skipIfNoConversation is true
  // Return null to signal that conversation discovery is needed
  // =========================================================
  if (!conversation && skipIfNoConversation) {
    console.log("ℹ️ Conversation not found, signaling for discovery");
    return null;
  }

  // =========================================================
  // 3️⃣ Create conversation if it doesn't exist (normal flow)
  // =========================================================
  if (!conversation) {
    conversation = await Conversation.create({
      creatorId,
      platform: "instagram",
      igConversationId,
      participantId: participant._id,
      unreadCount: 0,
      lastSyncedAt: new Date(),
      lastActivityAt: createdAt,
      label: "General",
      labelSource: "auto",
      creatorHasReplied: false, 
    });
    console.log("✅ New conversation created:", conversation._id);
  }

  // =========================================================
  // 4️⃣ Resolve sender correctly (NO HARD CODING)
  // =========================================================
  const isFromMe = senderIgUserId === businessIgUserId;

  const sender = isFromMe ? "me" : "them";
  const senderType = isFromMe ? "creator" : "participant";
  const senderTypeRef = isFromMe ? "users" : "participants";
  const senderId = isFromMe ? creatorId : participant._id;

  // =========================================================
  // 5️⃣ Create message (IDEMPOTENT - skip if already exists)
  // =========================================================
  const existing = await Message.findOne({ igMessageId }).lean();
  if (existing) {
    console.log("ℹ️ Message already exists:", igMessageId);
    
    // 🔥 FIX: Even if message exists, ensure we return the latest conversation state
    const freshConversation = await Conversation.findById(conversation._id).lean();
    return { conversation: freshConversation, message: existing };
  }

  const message = await Message.create({
    conversationId: conversation._id,
    platform: "instagram",
    igMessageId,

    sender,
    senderType,
    senderTypeRef,
    senderId,

    type,
    text,
    mediaUrl,
    mediaType,
    action,

    createdAtPlatform: createdAt,
    isRead: isFromMe, // Creator's own messages are always read
    isDeleted: false,
  });

  console.log("✅ Message created:", message._id);

  // =========================================================
  // 6️⃣ Update conversation snapshot (Snapshot only)
  // 🔥 We REMOVED the manual unreadCount incrementing here.
  // We only update lastMessage and timestamps. Recalculate handles the counts.
  // =========================================================
  const updateFields = {
    lastMessage: {
      text: text || (type === "image" ? "Sent an image" : type === "video" ? "Sent a video" : "Sent a message"),
      type,
      sender,
      timestamp: createdAt,
    },
    lastSyncedAt: new Date(),
  };

  // Build update operation for timestamps
  const updateOperation = {
    $set: updateFields,
    $max: { lastActivityAt: createdAt } // Always update activity time
  };

  // Update the conversation snapshot first
  await Conversation.findByIdAndUpdate(
    conversation._id,
    updateOperation,
    { new: true }
  );

  // =========================================================
  // 7️⃣ 🔥 RECALCULATE METRICS (The Source of Truth)
  // This guarantees unreadCount and creatorHasReplied are correct based on DB
  // =========================================================
  const finalConversation = await recalculateConversationMetrics(conversation._id);

  console.log("✅ Conversation updated:", {
    id: finalConversation._id,
    unreadCount: finalConversation.unreadCount,
    lastActivityAt: finalConversation.lastActivityAt,
    lastParticipantMessageAt: finalConversation.lastParticipantMessageAt,
    creatorHasReplied: finalConversation.creatorHasReplied,
    sender: sender,
  });

  return {
    conversation: finalConversation,
    message,
  };
}
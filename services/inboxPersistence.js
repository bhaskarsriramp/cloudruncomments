// services/inboxPersistence.js
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Participant from "../models/Participant.js";

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
  // 6️⃣ Update conversation snapshot
  // 🔥 FIXED: Always update if sender is "them" to ensure lastParticipantMessageAt is set
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

  // Build update operation
  const updateOperation = {
    $set: updateFields,
  };

  // 🔥 CRITICAL: Always update lastParticipantMessageAt if sender is "them"
  // Use $max to ensure we only set if newer
  if (sender === "them") {
    updateOperation.$max = {
      lastParticipantMessageAt: createdAt,
      lastActivityAt: createdAt,
    };
    updateOperation.$inc = { unreadCount: 1 };
  } else {
    // For creator messages, just update lastActivityAt if newer
    updateOperation.$max = {
      lastActivityAt: createdAt,
    };
  }

  // 🔥 FIXED: Use simpler update without complex conditions
  // $max ensures we only update if the new value is greater
  const updatedConversation = await Conversation.findByIdAndUpdate(
    conversation._id,
    updateOperation,
    { new: true }
  );

  const finalConversation = updatedConversation || conversation;

  console.log("✅ Conversation updated:", {
    id: finalConversation._id,
    unreadCount: finalConversation.unreadCount,
    lastActivityAt: finalConversation.lastActivityAt,
    lastParticipantMessageAt: finalConversation.lastParticipantMessageAt,
    sender: sender,
  });

  return {
    conversation: finalConversation,
    message,
  };
}
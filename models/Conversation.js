// models/Conversation.js
import mongoose from "mongoose";
const { Schema } = mongoose;

const LastMessageSchema = new Schema(
  {
    text: { type: String },
    type: { type: String, enum: ["text", "image", "video", "system"], default: "text" },
    sender: { type: String, enum: ["me", "them"], required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false }
);

const ConversationSchema = new Schema(
  {
    // Platform info
    platform: { type: String, enum: ["instagram"], required: true },
    igConversationId: { type: String, required: true },
    metaThreadId: { type: String },

    // Owner (creator)
    creatorId: { type: Schema.Types.ObjectId, ref: "users", required: true },

    // Other participant
    participantId: { type: Schema.Types.ObjectId, ref: "Participant", required: true },

    // Labeling
    label: {
      type: String,
      enum: ["Personal", "Lead", "General", "Business"],
      default: "General",
    },
    labelSource: {
      type: String,
      enum: ["auto", "manual", "ai"],
      default: "auto",
    },

        /* ---------- CONVERSATION INTELLIGENCE ---------- */

conversationIntent: {
  type: String,
  enum: ["Personal", "Lead", "Business", "General"],
  default: "General",
},

conversationIntentConfidence: {
  type: Number, // 0.0 → 1.0
  default: 0,
},

// Accumulated evidence (THIS PREVENTS FLIPPING)
intentSignals: {
  personal: { type: Number, default: 0 },
  lead: { type: Number, default: 0 },
  collaboration: { type: Number, default: 0 },
},

intentSignalsUpdatedAt: {
  type: Date,
  default: null,
},


conversationIntentUpdatedAt: {
  type: Date,
  default: null,
},

conversationLeadSeriousness: {
  type: Number,
  min: 0,
  max: 1,
  default: 0,
},
conversationLeadSeriousnessUpdatedAt: Date,


    // State
    isBlocked: { type: Boolean, default: false },

    // Inbox snapshot
    lastMessage: { type: LastMessageSchema },
    unreadCount: { type: Number, default: 0 },
    lastSyncedAt: Date,
    lastMetaCursor: String,
    lastMetaAfterCursor: String,   // for latest sync
lastMetaBeforeCursor: String,  // for older sync
lastParticipantMessageAt: { type: Date, index: true },
metaSyncCompleted: { type: Boolean, default: false },

notes: {
  text: { type: String, default: "" },
  updatedAt: { type: Date }
},

    // Sorting
    lastActivityAt: { type: Date, required: true },
  },
  { timestamps: true }
);

/* ---------- INDEXES ---------- */

// Prevent duplicate conversations per creator
ConversationSchema.index(
  { creatorId: 1, igConversationId: 1 },
  { unique: true }
);

// Inbox loading & sorting
ConversationSchema.index(
  { creatorId: 1, lastActivityAt: -1 }
);

// Label-based filtering
ConversationSchema.index(
  { creatorId: 1, label: 1 }
);

// Participant lookup
ConversationSchema.index(
  { participantId: 1 }
);

ConversationSchema.index(
  { creatorId: 1, platform: 1, igConversationId: 1 },
  { unique: true }
);


const Conversation =
  mongoose.models.Conversation ||
  mongoose.model("Conversation", ConversationSchema, "conversations");

export default Conversation;

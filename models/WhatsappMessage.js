import mongoose from "mongoose";
const { Schema } = mongoose;

const WhatsappMessageSchema = new Schema({
  phone: { type: String, required: true },          // full phone e.g. "+919876543210"
  code:  { type: String, default: null },            // 6-digit OTP (null for service alerts)
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  used:  { type: Boolean, default: false },          // prevent replay
  createdAt: { type: Date, default: Date.now, expires: 600 }, // auto-delete after 10 min

  // WhatsApp delivery tracking
  messageId:     { type: String, default: null },   // WA message id returned on send
  messageStatus: {
    type: String,
    enum: ["sent", "delivered", "read", "failed", "queued"],
    default: "sent",
  },

  message:      { type: String, default: null },   // actual message body that was sent
  templateName: { type: String, default: null },   // WA template name used e.g. "verify_user"
  messageType: {
    type: String,
    enum: ["otp", "p0", "p1"],
    default: "otp",
  },

  errorDelivery: { type: String, default: null },   // populated by webhook on failed/undelivered
});

WhatsappMessageSchema.index({ phone: 1, createdAt: -1 });

const WhatsappMessage =
  mongoose.models.WhatsappMessage ||
  mongoose.model("WhatsappMessage", WhatsappMessageSchema, "whatsapp_messages");

export default WhatsappMessage;

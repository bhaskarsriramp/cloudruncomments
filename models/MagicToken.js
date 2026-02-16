import mongoose from "mongoose";
const { Schema } = mongoose;

const MagicTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  chatUsername: { type: String, default: null },
  used: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  expires_at: { type: Date, required: true },
});

// Auto-delete expired tokens from MongoDB
MagicTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

const MagicToken =
  mongoose.models.MagicToken ||
  mongoose.model("MagicToken", MagicTokenSchema, "magic_tokens");

export default MagicToken;

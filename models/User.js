import mongoose from "mongoose";
const { Schema } = mongoose;

const User_Schema = new Schema({
  email: { type: String, required: true },
  name: { type: String },
  intro: { type: String },
  sub: { type: String },
  picture: { type: String },
  leftHeadImage: { type: String },
  rightTopImage: { type: String },
  rightBottomImage: { type: String },
  is_google_user: { type: Boolean },
  handleUserName: { type: String },

  find_leads: { type: Boolean, default: false },
  first_conv_pull: { type: Boolean, default: false },
  conv_pull: {
      type: String,
      enum: ["processed", "processing", "idle"],
      default: "idle"
    },
  creator_whatsapp_num: { type: String, default: null },
  handle_created: { type: Boolean, default: false },
  leads_plan_limit: { type: Number, default : 5 },
  leads_found: { type: Number, default : 0 },
  dms_plan_limit: { type: Number, default : 1000 },
  subscription_plan: {
      type: String,
      enum: ["free", "creator", "pro"],
      default: "free"
    },
  planBannerShowed: { type: Boolean, default: false},
  lead_agent: {type : Boolean, default: true},

  instagramConnected: { type: Boolean, default: false },
  igUserId: { type: String },
  igId: { type: String },
  igName: { type: String },
  igUsername: { type: String },
  fbPageId: { type: String },
  igProfilePic: { type: String },
  igFollowersCount: { type: Number },
  igFollowsCount: { type: Number },
  igMediaCount: { type: Number },
  fbLongLivedToken: { type: String },
  fbLongLivedTokenExpiry: { type: Date },
  fbLastRefreshAt: { type: Date },
  igBiography: {type : String},
  fbPageAccessToken: {type : String},
  has_profile_pic_ig: { type: Boolean, default: false },
  fbNeedsReconnect: { type: Boolean },
  automationFeedSubscribed : {type : Boolean, default : false },
  
  duplicateExists: { type: Boolean, default: false },
  duplicateInfo: {
    igUsername: { type: String },
    maskedEmail: { type: String },
  },

  igConversationsSync: {
  afterCursor: { type: String },
  hasMore: { type: Boolean, default: true },
  lastSyncedAt: { type: Date }
},


  demo_logged_in: { type: Boolean },
  demo_logged_date: { type: Date },



  socials: [{
    platform: { type: String },
    url: { type: String },
    created_at: { type: Date, default: Date.now },
  }],
  account_delete_code: { type: Number },
  last_login: { type: Date },
  loginHistory: [{ type: Date }],
  free_trial: { type: Boolean, default: true },
  free_trial_started_date: { type: Date, default: Date.now },
  free_trial_used: { type: Boolean, default: false },
  paid_subscription_active : { type: Boolean, default: false },

  store_enabled: { type: Boolean, default: false },
  dm_enabled: { type: Boolean, default: false },
  is_del: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date },
});

User_Schema.index({ email: 1, handleUserName: 1 }, { unique: true });

// Login lookup by email
User_Schema.index({ email: 1 });

// Page resolution by handle
User_Schema.index({ handleUserName: 1 });

// Duplicate detection by Instagram user ID
User_Schema.index({ igUserId: 1 });

// Register model as "User" but use existing collection "users"
const User = mongoose.models.User || mongoose.model("User", User_Schema, "users");
export default User;

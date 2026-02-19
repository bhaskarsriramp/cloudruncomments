import mongoose from 'mongoose';
const { Schema } = mongoose;


const DmsUsageSchema = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },

  year: {
    type: Number,
    required: true,
  },
  month: {
    type: Number,
    required: true,
    min: 1,
    max: 12,
  },
  total_dms_sent: {
    type: Number,
    default: 0,
  },
  lead_alerts_sent: {
    type: Number,
    default: 0,
  },
});

DmsUsageSchema.index({ user_id: 1, year: 1, month: 1 }, { unique: true });


const DmsUsage_Schema_Model = mongoose.models.DmsUsage || mongoose.model('DmsUsage', DmsUsageSchema, 'dms_usages');
export default DmsUsage_Schema_Model;

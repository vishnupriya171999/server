import mongoose from "mongoose";

const emailAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },

  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },

  // MVP only. Use Gmail/Yahoo app password; OAuth is the production path.
  emailPassword: {
    type: String,
    required: true,
  },

  provider: {
    type: String,
    default: "gmail",
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

emailAccountSchema.index({ userId: 1, email: 1 }, { unique: true });
emailAccountSchema.index({ email: 1 });

export default mongoose.model("EmailAccount", emailAccountSchema);

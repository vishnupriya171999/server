import mongoose from "mongoose";

const emailSchema = new mongoose.Schema(
  {
    subject: {
      type: String,
      required: true,
      trim: true,
    },

    sender: {
      type: String,
      required: true,
      trim: true,
    },

    receiver: {
      type: String,
      required: true,
      trim: true,
    },

    content: {
      type: String,
      required: true,
      trim: true,
    },

    // true = customer mail, false = reply
    isInbound: {
      type: Boolean,
      default: true,
    },

    // AI or manual reply
    aiGenerated: {
      type: Boolean,
      default: false,
    },

    // group mails like Gmail thread
    threadId: {
      type: String,
      required: true,
    },

    // optional fields
    cc: [String],
    bcc: [String],
    customerName: String,
  },
  {
    timestamps: true,
  }
);

export default mongoose.model("Email", emailSchema);
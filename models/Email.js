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

    // RFC mail threading helpers
    messageId: {
      type: String,
      index: true,
    },

    inReplyTo: String,

    references: [String],

    // optional fields
    cc: [String],
    bcc: [String],
    customerName: String,
    attachments: [
      {
        originalName: String,
        filename: String,
        mimeType: String,
        size: Number,
        path: String,
        url: String,
        data: Buffer,
        dataUrl: String,
        cid: String,
        contentDisposition: String,
      },
    ],

    // Alias used by the frontend for uploaded email files
    uploadedFiles: [
      {
        originalName: String,
        filename: String,
        mimeType: String,
        size: Number,
        path: String,
        url: String,
        data: Buffer,
        dataUrl: String,
        cid: String,
        contentDisposition: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

export default mongoose.model("Email", emailSchema);

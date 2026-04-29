import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import Email from "../models/Email.js";
import generateAIReply from "../aiReply.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const normalizeMessageId = (value) =>
  (value || "")
    .toString()
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "");

const extractMessageIds = (value) => {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  const ids = [];

  for (const item of values) {
    const text = normalizeMessageId(item);
    if (!text) {
      continue;
    }

    const matches = text.match(/<[^>]+>/g);
    if (matches?.length) {
      ids.push(...matches.map(normalizeMessageId));
      continue;
    }

    ids.push(
      ...text
        .split(/[\s,]+/)
        .map(normalizeMessageId)
        .filter(Boolean)
    );
  }

  return [...new Set(ids)];
};

const buildFallbackMessageId = (prefix) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const safeParseJson = (value) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const normalizeAttachmentList = (value) => {
  if (!value) return [];

  const items = Array.isArray(value) ? value : [value];

  return items
    .map((item) => {
      if (!item) return null;

      const rawData = item.data || item.buffer || null;
      const dataBuffer = Buffer.isBuffer(rawData)
        ? rawData
        : typeof rawData === "string"
          ? Buffer.from(rawData, "base64")
          : null;
      const mimeType = item.mimeType || item.mimetype || "application/octet-stream";

      return {
        originalName: item.originalName || item.originalname || "attachment",
        filename: item.filename,
        mimeType,
        size: item.size || dataBuffer?.length || 0,
        path: item.path,
        url: item.url || "",
        data: dataBuffer,
        dataUrl:
          item.dataUrl ||
          (dataBuffer
            ? `data:${mimeType};base64,${dataBuffer.toString("base64")}`
            : ""),
        cid: item.cid || "",
        contentDisposition: item.contentDisposition || "",
      };
    })
    .filter(Boolean);
};

const mapUploadedFile = (file) => {
  const safeName = (file.originalname || "attachment")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`;

  return {
    originalName: file.originalname,
    filename,
    mimeType: file.mimetype,
    size: file.size,
    path: "",
    url: "",
    data: file.buffer,
    dataUrl: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
    cid: "",
    contentDisposition: file.fieldname ? `form-data; name="${file.fieldname}"` : "",
  };
};

const toBoolean = (value) => value === true || value === "true";

const serializeEmailDoc = (emailDoc) => {
  if (!emailDoc) {
    return emailDoc;
  }

  const plain = typeof emailDoc.toObject === "function" ? emailDoc.toObject() : emailDoc;
  const attachments = normalizeAttachmentList(plain.attachments || []);
  const uploadedFiles = normalizeAttachmentList(plain.uploadedFiles || []);

  return {
    ...plain,
    attachments,
    uploadedFiles,
  };
};

const findEmailByAnyReference = async (value) => {
  const normalized = normalizeMessageId(value);
  if (!normalized) {
    return null;
  }

  if (isObjectId(normalized)) {
    const byId = await Email.findById(normalized);
    if (byId) {
      return byId;
    }
  }

  return Email.findOne({
    $or: [
      { messageId: normalized },
      { messageId: value },
    ],
  });
};

const resolveThreadContext = async (body) => {
  const explicitThreadId = (body.threadId || "").trim();
  const replyCandidates = [
    body.replyToEmailId,
    body.replyToId,
    body.parentEmailId,
    body.parentMessageId,
    body.replyToMessageId,
    body.inReplyTo,
    ...(body.references ? extractMessageIds(body.references).slice(-1) : []),
  ].filter(Boolean);

  let parentEmail = null;

  for (const candidate of replyCandidates) {
    parentEmail = await findEmailByAnyReference(candidate);
    if (parentEmail) {
      break;
    }
  }

  if (!parentEmail && explicitThreadId) {
    parentEmail = await Email.findOne({ threadId: explicitThreadId }).sort({
      createdAt: -1,
    });
  }

  const messageId = normalizeMessageId(body.messageId) || buildFallbackMessageId("message");
  const threadId = explicitThreadId || parentEmail?.threadId || messageId;
  const inReplyTo = normalizeMessageId(
    body.inReplyTo || parentEmail?.messageId || ""
  );
  const parentReferences = extractMessageIds(parentEmail?.references || body.references);
  const references = [
    ...new Set(
      [
        ...parentReferences,
        ...(inReplyTo ? [inReplyTo] : []),
      ].filter(Boolean)
    ),
  ];

  return {
    threadId,
    messageId,
    inReplyTo,
    references,
  };
};

// 📩 CREATE EMAIL + AUTO AI REPLY
router.post("/add", upload.any(), async (req, res) => {
  try {
    const isInbound = toBoolean(req.body.isInbound);
    const multerFiles = Array.isArray(req.files) ? req.files.map(mapUploadedFile) : [];
    const bodyUploadedFiles = normalizeAttachmentList(req.body.uploadedFiles || []);
    const bodyAttachments = normalizeAttachmentList(req.body.attachments || []);

    const uploadedFiles = normalizeAttachmentList([
      ...bodyUploadedFiles,
      ...bodyAttachments,
      ...multerFiles,
    ]);
    const attachments = normalizeAttachmentList([
      ...bodyAttachments,
      ...bodyUploadedFiles,
      ...multerFiles,
    ]);
    const threadContext = await resolveThreadContext(req.body);

    const email = await Email.create({
      ...req.body,
      threadId: threadContext.threadId,
      messageId: threadContext.messageId,
      inReplyTo: threadContext.inReplyTo,
      references: threadContext.references,
      attachments,
      uploadedFiles,
    });

    // If inbound → auto reply
    let aiReply = null;

    if (isInbound) {
      const emailText = [req.body.content, req.body.subject]
        .filter(Boolean)
        .join("\n\n");
      const replyText = await generateAIReply(
        emailText || req.body.subject || "general",
        req.body.subject || "general",
        attachments
      );

      aiReply = await Email.create({
        subject: `Re: ${req.body.subject}`,
        sender: req.body.receiver,
        receiver: req.body.sender,
        content: replyText,
        isInbound: false,
        aiGenerated: true,
        threadId: threadContext.threadId,
        inReplyTo: threadContext.messageId,
        references: [...threadContext.references, threadContext.messageId].filter(Boolean),
        messageId: buildFallbackMessageId("reply"),
      });
    }

    res.status(201).json({
      email: serializeEmailDoc(email),
      aiReply: serializeEmailDoc(aiReply),
      threadId: threadContext.threadId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📥 GET ALL EMAILS FOR FRONTEND LIST
router.get("/", async (req, res) => {
  try {
    const emails = await Email.find()
      .sort({ createdAt: -1 });

    res.json(emails.map(serializeEmailDoc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📊 GET EMAIL COUNTS
router.get("/stats", async (_req, res) => {
  try {
    const [total, inbound, outbound, aiReplies] = await Promise.all([
      Email.countDocuments(),
      Email.countDocuments({ isInbound: true }),
      Email.countDocuments({ isInbound: false }),
      Email.countDocuments({ aiGenerated: true }),
    ]);

    res.json({
      total,
      inbound,
      outbound,
      aiReplies,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 💬 GET THREAD (conversation view)
router.get("/thread/:threadId", async (req, res) => {
  try {
    const emails = await Email.find({
      threadId: req.params.threadId,
    }).sort({ createdAt: 1 });

    res.json(emails.map(serializeEmailDoc));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📄 GET SINGLE EMAIL
router.get("/:id", async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);

    if (!email) {
      return res.status(404).json({ error: "Email not found" });
    }

    res.json(serializeEmailDoc(email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

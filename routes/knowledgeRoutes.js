import crypto from "crypto";
import express from "express";
import {
  ensureKnowledgeIndex,
  knowledgeIndex,
  searchKnowledgeBase,
} from "../services/meiliClient.js";

const router = express.Router();

const toArray = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const createId = (payload) =>
  crypto
    .createHash("sha256")
    .update(
      [
        payload.title,
        payload.question,
        payload.category,
        payload.content || payload.answer,
      ]
        .filter(Boolean)
        .join("|")
    )
    .digest("hex")
    .slice(0, 24);

const normalizeDocument = (body) => {
  const now = new Date().toISOString();
  const title = String(body.title || body.question || "").trim();
  const answer = String(body.answer || body.content || "").trim();
  const content = String(body.content || body.answer || "").trim();

  return {
    id: String(body.id || createId({ ...body, title, answer, content })).trim(),
    title,
    question: String(body.question || title).trim(),
    answer,
    content,
    category: String(body.category || "general").trim(),
    tags: toArray(body.tags),
    source: String(body.source || "manual").trim(),
    createdAt: body.createdAt || now,
    updatedAt: now,
  };
};

router.post("/documents", async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const documents = items.map(normalizeDocument);
    const invalid = documents.find((doc) => !doc.title || (!doc.answer && !doc.content));

    if (invalid) {
      return res.status(400).json({
        message: "Each knowledge document needs a title/question and answer/content.",
      });
    }

    const index = await ensureKnowledgeIndex();
    const task = await index.addDocuments(documents);

    return res.status(202).json({
      message: "Knowledge document indexing started.",
      taskUid: task.taskUid,
      documents,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/documents", async (req, res) => {
  try {
    const index = await ensureKnowledgeIndex();
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const result = await index.getDocuments({ limit });

    return res.json({
      documents: result.results || [],
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/search", async (req, res) => {
  try {
    const hits = await searchKnowledgeBase(req.query.q, {
      limit: Number(req.query.limit || 10),
    });

    return res.json({ hits });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/documents/:id", async (req, res) => {
  try {
    const index = await ensureKnowledgeIndex();
    const document = await index.getDocument(req.params.id);

    return res.json(document);
  } catch (err) {
    const status = err.code === "document_not_found" ? 404 : 500;
    return res.status(status).json({ message: err.message });
  }
});

router.delete("/documents/:id", async (req, res) => {
  try {
    const index = knowledgeIndex();
    const task = await index.deleteDocument(req.params.id);

    return res.status(202).json({
      message: "Knowledge document deletion started.",
      taskUid: task.taskUid,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.post("/seed", async (_req, res) => {
  try {
    const seedDocs = [
      {
        id: "default-greeting",
        title: "Default support acknowledgement",
        question: "How should the AI acknowledge a new support email?",
        answer:
          "Thank the customer for reaching out, acknowledge the request clearly, and tell them the team will review the details and respond with the next step.",
        category: "template",
        tags: ["support", "reply"],
      },
      {
        id: "attachment-review",
        title: "Attachment received",
        question: "How should the AI reply when an attachment is included?",
        answer:
          "Confirm that the attachment was received and say it will be reviewed before giving a final answer. Do not say an attachment is missing when one is present.",
        category: "template",
        tags: ["attachment", "support"],
      },
    ].map(normalizeDocument);

    const index = await ensureKnowledgeIndex();
    const task = await index.addDocuments(seedDocs);

    return res.status(202).json({
      message: "Seed knowledge indexing started.",
      taskUid: task.taskUid,
      documents: seedDocs,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

export default router;

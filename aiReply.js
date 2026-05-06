import { Groq } from "groq-sdk";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { formatKnowledgeContext, searchKnowledgeBase } from "./services/meiliClient.js";

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".log",
  ".html",
  ".htm",
]);

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

const IMAGE_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const safePreview = (text, maxLength = 1500) =>
  (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const ATTACHMENT_MISSING_RE =
  /(?:couldn['’]t|could not|can(?:not|'t)|did not|don['’]t|do not)\s+(?:find|see|detect|spot)\s+(?:an?\s+)?attachment/i;

const GREETING_RE = /^(dear|hello|hi|hey)\b/i;
const SIGN_OFF_RE = /^(best regards|kind regards|regards|sincerely|thanks|thank you)\b/i;

const cleanAIReplyBody = (text, attachments = []) => {
  const source = (text || "").trim();
  if (!source) {
    return source;
  }

  if (attachments.length && ATTACHMENT_MISSING_RE.test(source)) {
    const hasImage = attachments.some((attachment) =>
      (attachment?.mimeType || attachment?.contentType || "").toLowerCase().startsWith("image/")
    );

    return hasImage
      ? "Thanks for sharing the photo. I’ll review it and get back to you shortly."
      : "Thanks for sending the attachment. I’ll review it and get back to you shortly.";
  }

  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length && GREETING_RE.test(lines[0])) {
    lines.shift();
  }

  const signOffIndex = lines.findIndex((line) => SIGN_OFF_RE.test(line));
  if (signOffIndex >= 0) {
    lines.splice(signOffIndex);
  }

  return lines.join("\n").trim() || source;
};

const looksLikeTextAttachment = (attachment) => {
  const mimeType = (attachment?.mimeType || attachment?.contentType || "").toLowerCase();
  if (mimeType.startsWith("text/")) {
    return true;
  }

  if (
    [
      "application/json",
      "application/xml",
      "application/xhtml+xml",
      "application/javascript",
    ].includes(mimeType)
  ) {
    return true;
  }

  const filename = (attachment?.originalName || attachment?.filename || "").toLowerCase();
  return TEXT_EXTENSIONS.has(path.extname(filename));
};

const looksLikeImageAttachment = (attachment) => {
  const mimeType = (attachment?.mimeType || attachment?.contentType || "").toLowerCase();
  if (mimeType.startsWith("image/")) {
    return true;
  }

  const filename = (attachment?.originalName || attachment?.filename || "").toLowerCase();
  return IMAGE_EXTENSIONS.has(path.extname(filename));
};

const resolveAttachmentPath = (attachment) => {
  const directPath = (attachment?.path || "").trim();
  if (directPath && fsSync.existsSync(directPath)) {
    return directPath;
  }

  const urlPath = (attachment?.url || "").trim();
  if (urlPath.startsWith("/uploads/")) {
    const localPath = path.resolve(process.cwd(), urlPath.slice(1));
    if (fsSync.existsSync(localPath)) {
      return localPath;
    }
  }

  return "";
};

const getAttachmentMimeType = (attachment) => {
  const mimeType = (attachment?.mimeType || attachment?.contentType || "").trim().toLowerCase();
  if (mimeType) {
    return mimeType;
  }

  const filename = (attachment?.originalName || attachment?.filename || "").toLowerCase();
  return IMAGE_MIME_BY_EXT[path.extname(filename)] || "application/octet-stream";
};

const analyzeImageAttachments = async (attachments = []) => {
  if (!openai) {
    return "";
  }

  const imageAttachments = attachments.filter(looksLikeImageAttachment);
  if (!imageAttachments.length) {
    return "";
  }

  const inputContent = [];

  for (const attachment of imageAttachments.slice(0, 3)) {
    const resolvedPath = resolveAttachmentPath(attachment);
    if (!resolvedPath) {
      continue;
    }

    const fileBuffer = await fs.readFile(resolvedPath);
    const mimeType = getAttachmentMimeType(attachment);
    const dataUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;

    inputContent.push({
      type: "input_image",
      image_url: dataUrl,
      detail: "high",
    });
  }

  if (!inputContent.length) {
    return "";
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Analyze the image(s) carefully. Describe what is visible, any text you can read, colors, objects, setting, and anything notable. If the image is unclear, say what is uncertain. Keep it concise but useful.",
          },
        ],
      },
      {
        role: "user",
        content: inputContent,
      },
    ],
    max_output_tokens: 300,
  });

  return (response.output_text || "").trim();
};

const describeAttachments = async (attachments = []) => {
  if (!Array.isArray(attachments) || !attachments.length) {
    return "";
  }

  const lines = [];

  for (const attachment of attachments) {
    const name = attachment?.originalName || attachment?.filename || "attachment";
    const mimeType = attachment?.mimeType || attachment?.contentType || "unknown";
    const size = typeof attachment?.size === "number" ? `, ${attachment.size} bytes` : "";
    let preview = "";

    if (attachment?.path && looksLikeTextAttachment(attachment)) {
      try {
        const raw = await fs.readFile(attachment.path, "utf8");
        preview = safePreview(raw);
      } catch {
        preview = "";
      }
    }

    if (preview) {
      lines.push(`- ${name} (${mimeType}${size}): ${preview}`);
    } else {
      lines.push(`- ${name} (${mimeType}${size})`);
    }
  }

  return lines.join("\n");
};

async function generateAIReply(emailText, moduleContext = "general", attachments = []) {
  const attachmentContext = await describeAttachments(attachments);
  const incomingText = safePreview(emailText, 3000);
  let imageAnalysis = "";
  let knowledgeContext = "";

  try {
    imageAnalysis = await analyzeImageAttachments(attachments);
  } catch (err) {
    console.error("Image analysis error:", err.message);
  }

  try {
    const knowledgeHits = await searchKnowledgeBase(
      [moduleContext, incomingText].filter(Boolean).join("\n"),
      { limit: 5 }
    );
    knowledgeContext = formatKnowledgeContext(knowledgeHits);
  } catch (err) {
    console.error("Knowledge lookup error:", err.message);
  }

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are an assistant for a company. Generate a professional, friendly, and concise email body only. Do not include a greeting, closing, signature, or placeholders like "Dear [Name]". Module context: ${moduleContext}. If Knowledge base context is provided, use it as the source of truth for policies, FAQs, templates, and support facts. If the knowledge base does not contain the answer, give a helpful next step without inventing policy details. If attachments are provided, use them as part of the incoming message context and never say there is no attachment when the attachment list is non-empty. If Image analysis is provided, answer from that analysis and describe the image clearly.`,
        },
        {
          role: "user",
          content: [
            `Incoming email content: "${incomingText}"`,
            knowledgeContext ? `Knowledge base context:\n${knowledgeContext}` : "",
            attachmentContext ? `Attachments:\n${attachmentContext}` : "",
            imageAnalysis ? `Image analysis:\n${imageAnalysis}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      temperature: 1,
      max_completion_tokens: 256,
      top_p: 1,
      stream: false,
      stop: null,
    });

    return cleanAIReplyBody(chatCompletion.choices[0].message.content, attachments);
  } catch (err) {
    console.error("AI reply error:", err.message);
    return "Thanks for your email. We will get back to you soon.";
  }
}

export default generateAIReply;

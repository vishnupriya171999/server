import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { randomUUID } from "crypto";
import { meiliClient } from "./meiliClient.js";

const DEFAULT_CHUNK_SIZE = Number(process.env.KNOWLEDGE_CHUNK_SIZE || 500);
const DEFAULT_CHUNK_OVERLAP = Number(process.env.KNOWLEDGE_CHUNK_OVERLAP || 50);

export const getIndexName = (domainId) => {
  const cleanDomain = String(domainId || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `docs_${cleanDomain || "default"}`;
};

export const ensureDomainIndex = async (domainId) => {
  const indexName = getIndexName(domainId);

  try {
    await meiliClient.getIndex(indexName);
  } catch (err) {
    const notFound =
      err?.code === "index_not_found" ||
      err?.cause?.code === "index_not_found" ||
      /index .* not found/i.test(err?.message || "");

    if (!notFound) {
      throw err;
    }

    await meiliClient.createIndex(indexName, { primaryKey: "id" });
    console.log("Created index:", indexName);
  }

  const index = meiliClient.index(indexName);
  await index.updateSearchableAttributes(["title", "content", "source", "domain_id"]);
  await index.updateFilterableAttributes(["domain_id", "source"]);

  return index;
};

const decodeAscii85 = (input) => {
  const clean = input
    .replace(/^<~/, "")
    .replace(/~>$/, "")
    .replace(/\s+/g, "");
  const bytes = [];
  let group = [];

  for (const char of clean) {
    if (char === "z" && group.length === 0) {
      bytes.push(0, 0, 0, 0);
      continue;
    }

    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) {
      continue;
    }

    group.push(code - 33);

    if (group.length === 5) {
      let value = 0;
      for (const digit of group) {
        value = value * 85 + digit;
      }

      bytes.push(
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255
      );
      group = [];
    }
  }

  if (group.length) {
    const padding = 5 - group.length;
    for (let index = 0; index < padding; index += 1) {
      group.push(84);
    }

    let value = 0;
    for (const digit of group) {
      value = value * 85 + digit;
    }

    const decoded = [
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255,
    ];
    bytes.push(...decoded.slice(0, 4 - padding));
  }

  return Buffer.from(bytes);
};

const decodePdfString = (value) =>
  value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_match, escapeValue) => {
    if (/^[0-7]+$/.test(escapeValue)) {
      return String.fromCharCode(Number.parseInt(escapeValue, 8));
    }

    const escapes = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      "(": "(",
      ")": ")",
      "\\": "\\",
    };

    return escapes[escapeValue] || escapeValue;
  });

const extractTextFromPdfContent = (content) => {
  const pieces = [];
  const stringPattern = /\((?:\\.|[^\\()])*\)/g;
  let match = null;

  while ((match = stringPattern.exec(content)) !== null) {
    const raw = match[0].slice(1, -1);
    const text = decodePdfString(raw).replace(/\s+/g, " ").trim();

    if (text) {
      pieces.push(text);
    }
  }

  return pieces.join("\n");
};

export const extractPdfText = async (filePath) => {
  const buffer = await fs.readFile(filePath);
  const pdf = buffer.toString("latin1");
  const pageTexts = [];
  let searchFrom = 0;

  while (true) {
    const streamStart = pdf.indexOf("stream", searchFrom);
    if (streamStart < 0) {
      break;
    }

    const dataStart =
      pdf.slice(streamStart + "stream".length, streamStart + "stream".length + 2) === "\r\n"
        ? streamStart + "stream".length + 2
        : streamStart + "stream".length + 1;
    const streamEnd = pdf.indexOf("endstream", dataStart);
    if (streamEnd < 0) {
      break;
    }

    const dictionaryStart = pdf.lastIndexOf("<<", streamStart);
    const dictionaryEnd = pdf.lastIndexOf(">>", streamStart);
    const dictionary =
      dictionaryStart >= 0 && dictionaryEnd > dictionaryStart
        ? pdf.slice(dictionaryStart, dictionaryEnd + 2)
        : "";
    const rawStream = pdf.slice(dataStart, streamEnd).replace(/\r?\n$/, "");
    let streamBuffer = Buffer.from(rawStream, "latin1");

    if (dictionary.includes("ASCII85Decode")) {
      streamBuffer = decodeAscii85(streamBuffer.toString("latin1"));
    }

    if (dictionary.includes("FlateDecode")) {
      streamBuffer = zlib.inflateSync(streamBuffer);
    }

    const pageText = extractTextFromPdfContent(streamBuffer.toString("latin1"));
    if (pageText) {
      pageTexts.push(pageText);
    }

    searchFrom = streamEnd + "endstream".length;
  }

  return pageTexts.join("\n\n").replace(/[ \t]+\n/g, "\n").trim();
};

export const splitText = (
  text,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP
) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    const maxEnd = Math.min(start + chunkSize, normalized.length);
    const boundary = normalized.lastIndexOf(" ", maxEnd);
    const end = boundary > start + chunkSize * 0.6 ? boundary : maxEnd;
    const chunk = normalized.slice(start, end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(0, end - chunkOverlap);
  }

  return chunks;
};

export const loadDocumentText = async (documentUrl) => {
  if (/^https?:\/\//i.test(documentUrl)) {
    const response = await fetch(documentUrl);
    if (!response.ok) {
      throw new Error(`Unable to fetch document: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const data = Buffer.from(await response.arrayBuffer());

    if (contentType.includes("pdf") || documentUrl.toLowerCase().endsWith(".pdf")) {
      const tempPath = path.join(process.cwd(), `temp-${Date.now()}.pdf`);
      await fs.writeFile(tempPath, data);
      try {
        return extractPdfText(tempPath);
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
    }

    return data.toString("utf8");
  }

  const localPath = path.resolve(documentUrl);
  if (localPath.toLowerCase().endsWith(".pdf")) {
    return extractPdfText(localPath);
  }

  return fs.readFile(localPath, "utf8");
};

export const indexDocument = async ({ document_url, domain_id, title }) => {
  if (!document_url || !domain_id) {
    throw new Error("document_url and domain_id are required.");
  }

  const indexName = getIndexName(domain_id);
  const index = await ensureDomainIndex(domain_id);
  const text = await loadDocumentText(document_url);
  const chunks = splitText(text);

  if (!chunks.length) {
    throw new Error("No text could be extracted from the document.");
  }

  const now = new Date().toISOString();
  const documents = chunks.map((chunk, chunkIndex) => ({
    id: randomUUID(),
    domain_id,
    title: title || path.basename(document_url),
    content: chunk,
    source: document_url,
    chunk_index: chunkIndex,
    createdAt: now,
  }));

  const task = await index.addDocuments(documents);
  await meiliClient.waitForTask(task.taskUid, { timeOutMs: 30000, intervalMs: 200 });

  console.log("Indexed documents:", JSON.stringify(documents, null, 2));

  return {
    indexName,
    taskUid: task.taskUid,
    chunks: documents.length,
    documents,
  };
};

export const searchDomainContext = async ({ query, domain_id, limit = 5 }) => {
  if (!query || !domain_id) {
    throw new Error("query and domain_id are required.");
  }

  const index = meiliClient.index(getIndexName(domain_id));
  const results = await index.search(query, { limit });
  const context = (results.hits || []).map((hit) => hit.content).join("\n");

  return {
    context,
    hits: results.hits || [],
  };
};

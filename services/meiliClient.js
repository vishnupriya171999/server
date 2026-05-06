import dotenv from "dotenv";
import { Meilisearch } from "meilisearch";

dotenv.config({ quiet: true });

const MEILI_HOST = process.env.MEILI_HOST || "http://localhost:7700";
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || "";
const KNOWLEDGE_INDEX = process.env.MEILI_KNOWLEDGE_INDEX || "knowledge_base";

export const meiliClient = new Meilisearch({
  host: MEILI_HOST,
  apiKey: MEILI_MASTER_KEY,
});

export const knowledgeIndex = () => meiliClient.index(KNOWLEDGE_INDEX);

const isIndexNotFound = (err) =>
  err?.code === "index_not_found" ||
  err?.cause?.code === "index_not_found" ||
  /index .* not found/i.test(err?.message || "");

export const ensureKnowledgeIndex = async () => {
  try {
    await meiliClient.getIndex(KNOWLEDGE_INDEX);
  } catch (err) {
    if (!isIndexNotFound(err)) {
      throw err;
    }

    await meiliClient.createIndex(KNOWLEDGE_INDEX, { primaryKey: "id" });
  }

  const index = knowledgeIndex();

  await index.updateSearchableAttributes([
    "title",
    "question",
    "answer",
    "content",
    "tags",
    "category",
  ]);

  await index.updateFilterableAttributes(["category", "tags"]);
  await index.updateSortableAttributes(["updatedAt", "createdAt"]);

  return index;
};

export const searchKnowledgeBase = async (query, options = {}) => {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return [];
  }

  try {
    const index = await ensureKnowledgeIndex();
    const results = await index.search(cleanQuery, {
      limit: options.limit || 5,
      attributesToRetrieve: [
        "id",
        "title",
        "question",
        "answer",
        "content",
        "category",
        "tags",
        "updatedAt",
      ],
      attributesToCrop: ["answer", "content"],
      cropLength: 80,
    });

    return results.hits || [];
  } catch (err) {
    console.error("Knowledge base search error:", err.message);
    return [];
  }
};

export const formatKnowledgeContext = (hits = []) =>
  hits
    .map((hit, index) => {
      const title = hit.title || hit.question || `Knowledge result ${index + 1}`;
      const body = hit.answer || hit.content || "";
      const category = hit.category ? `Category: ${hit.category}` : "";

      return [`${index + 1}. ${title}`, category, body].filter(Boolean).join("\n");
    })
    .join("\n\n");

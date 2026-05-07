import dotenv from "dotenv";
import { indexDocument, searchDomainContext } from "../services/documentIndexService.js";

dotenv.config({ quiet: true });

const documentUrl =
  process.argv[2] || "C:\\Users\\HP\\Downloads\\Complete_AI_Email_Agent_Knowledge_Base.pdf";
const domainId = process.argv[3] || "ai_email_agent";
const title = process.argv[4] || "Complete AI Email Agent Knowledge Base";

try {
  const result = await indexDocument({
    document_url: documentUrl,
    domain_id: domainId,
    title,
  });

  console.log("\nFinal indexed documents:");
  console.log(JSON.stringify(result.documents, null, 2));

  const searchPreview = await searchDomainContext({
    query: "customer support replies",
    domain_id: domainId,
    limit: 3,
  });

  console.log("\nSearch preview:");
  console.log(JSON.stringify(searchPreview, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

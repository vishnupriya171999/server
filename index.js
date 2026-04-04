import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";
import connectDB from "./db.js";
import emailRoutes from "./routes/emailRoutes.js";
import processEmails from "./emailProcessor.js";

dotenv.config();

const app = express();
let isProcessingEmails = false;

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "API is running" });
});

app.use("/api/emails", emailRoutes);

const startEmailCron = () => {
  cron.schedule("*/10 * * * * *", async () => {
    if (isProcessingEmails) {
      console.log("Checking emails skipped: previous run still in progress.");
      return;
    }

    isProcessingEmails = true;

    try {
      console.log("Checking emails...");
      await processEmails();
    } catch (err) {
      console.error("Email cron error:", err.message);
    } finally {
      isProcessingEmails = false;
    }
  });
};

const startServer = async () => {
  await connectDB();

  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`Server running on port ${port} 🚀`);
  });

  startEmailCron();
};

startServer();

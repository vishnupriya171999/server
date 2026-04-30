import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import connectDB from "./db.js";
import authRoutes from "./routes/authRoutes.js";
import emailRoutes from "./routes/emailRoutes.js";
import { startEmailPolling } from "./emailProcessor.js";

dotenv.config();

const app = express();
const UPLOADS_ROOT = path.resolve(
  process.env.UPLOADS_ROOT || path.resolve(process.cwd(), "uploads")
);

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(UPLOADS_ROOT));
app.get("/", (_req, res) => {
  res.json({ message: "API is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/emails", emailRoutes);

const startServer = async () => {
  await connectDB();

  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`Server running on port ${port} 🚀`);
  });

  startEmailPolling();
};

startServer();

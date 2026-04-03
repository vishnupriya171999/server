import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./db.js";
import emailRoutes from "./routes/emailRoutes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "API is running" });
});

app.use("/api/emails", emailRoutes);

const startServer = async () => {
  await connectDB();

  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`Server running on port ${port} 🚀`);
  });
};

startServer();

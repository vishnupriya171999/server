import express from "express";
import Email from "../models/Email.js";

const router = express.Router();

router.post("/add", async (req, res) => {
  try {
    const newEmail = await Email.create(req.body);
    res.status(201).json(newEmail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", async (_req, res) => {
  try {
    const emails = await Email.find().sort({ createdAt: -1 });
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);

    if (!email) {
      return res.status(404).json({ error: "Email not found" });
    }

    res.json(email);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;


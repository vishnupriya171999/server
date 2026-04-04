import express from "express";
import Email from "../models/Email.js";

const router = express.Router();


// 📩 CREATE EMAIL + AUTO AI REPLY
router.post("/add", async (req, res) => {
  try {
    const email = await Email.create(req.body);

    // If inbound → auto reply
    let aiReply = null;

    if (req.body.isInbound) {
      aiReply = await Email.create({
        subject: `Re: ${req.body.subject}`,
        sender: req.body.receiver,
        receiver: req.body.sender,
        content: "Thank you for your email. Our team will get back to you shortly.",
        isInbound: false,
        aiGenerated: true,
        threadId: req.body.threadId,
      });
    }

    res.status(201).json({ email, aiReply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// 📥 GET INBOX (only customer mails)
router.get("/", async (req, res) => {
  try {
    const emails = await Email.find({ isInbound: true })
      .sort({ createdAt: -1 });

    res.json(emails);
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

    res.json(email);
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

    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
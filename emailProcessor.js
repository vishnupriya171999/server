import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import Email from "./models/Email.js";

const EMAIL = process.env.EMAIL_ADDRESS || "thinkreplyai@gmail.com";
const PASSWORD = process.env.EMAIL_APP_PASSWORD || "thinkreply@123";

const imapConfig = {
  imap: {
    user: EMAIL,
    password: PASSWORD,
    host: "imap.gmail.com",
    port: 993,
    tls: true,
  },
};

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL,
    pass: PASSWORD,
  },
});

export const processEmails = async () => {
  let connection;

  try {
    connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    const messages = await connection.search(["UNSEEN"], {
      bodies: [""],
    });

    for (const item of messages) {
      const rawBody = item.parts?.find((part) => part.which === "")?.body;

      if (!rawBody) {
        continue;
      }

      const parsed = await simpleParser(rawBody);
      const fromEmail = parsed.from?.value?.[0]?.address;

      if (!fromEmail) {
        continue;
      }

      const subject = parsed.subject || "No Subject";
      const threadId =
        parsed.messageId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      await Email.create({
        subject,
        sender: fromEmail,
        receiver: EMAIL,
        content: parsed.text || "",
        isInbound: true,
        threadId,
      });

      const replyText = "Thanks for your email. We will get back to you soon.";

      await transporter.sendMail({
        from: EMAIL,
        to: fromEmail,
        subject: `Re: ${subject}`,
        text: replyText,
      });

      await Email.create({
        subject: `Re: ${subject}`,
        sender: EMAIL,
        receiver: fromEmail,
        content: replyText,
        isInbound: false,
        aiGenerated: true,
        threadId,
      });
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    if (connection) {
      connection.end();
    }
  }
};

export default processEmails;

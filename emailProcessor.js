import Imap from "imap";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import Email from "./models/Email.js";
import EmailAccount from "./models/EmailAccount.js";
import generateAIReply from "./aiReply.js";
import { getAutoReplyBlockReason, stripQuotedReplyText } from "./services/autoReplyGuard.js";
import path from "path";
import fs from "fs/promises";

dotenv.config();

const normalizePassword = (value) => String(value || "").replace(/\s+/g, "");

const IMAP_HOST_GMAIL = process.env.IMAP_SMTP_HOST_GMAIL || "imap.gmail.com";
const IMAP_HOST_YAHOO = process.env.IMAP_SMTP_HOST_YAHOO || "imap.mail.yahoo.com";
const IMAP_HOST_PORT = Number(process.env.IMAP_SMTP_HOST_PORT || 993);
const IMAP_ALLOW_SELF_SIGNED = process.env.IMAP_ALLOW_SELF_SIGNED === "true";

const FETCH_INTERVAL_MS = Number(process.env.FETCH_INTERVAL_MS || 5000);
const SESSION_MS = Number(process.env.SESSION_MS || 300000);

const ASSISTANT_NAME = "Vishnupriya";
const ASSISTANT_ROLE = "Ai Agent";
const COMPANY_NAME = "Ai Agent";

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/zip": ".zip",
};

const normalizeMessageId = (value) =>
  (value || "")
    .toString()
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "");

const extractMessageIds = (value) => {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  const ids = [];

  for (const item of values) {
    const text = (item || "").toString().trim();
    if (!text) {
      continue;
    }

    const matches = text.match(/<[^>]+>/g);
    if (matches?.length) {
      ids.push(...matches.map(normalizeMessageId));
      continue;
    }

    ids.push(
      ...text
        .split(/[\s,]+/)
        .map(normalizeMessageId)
        .filter(Boolean)
    );
  }

  return [...new Set(ids.filter(Boolean))];
};

const formatMessageIdHeader = (value) => {
  const ids = extractMessageIds(value);

  if (!ids.length) {
    return undefined;
  }

  return ids.map((id) => `<${id}>`).join(" ");
};

const formatSenderName = (parsedFrom, fallbackEmail) => {
  const displayName = parsedFrom?.value?.[0]?.name?.trim();
  if (displayName) {
    return displayName;
  }

  const localPart = (fallbackEmail || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  if (!localPart) {
    return "there";
  }

  return localPart.replace(/\b\w/g, (char) => char.toUpperCase());
};

const sanitizeFilename = (name) =>
  (name || "attachment")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const getAttachmentFilename = (attachment, uid, index) => {
  const originalName = sanitizeFilename(attachment?.filename || attachment?.name);
  const extFromMime = MIME_EXTENSIONS[(attachment?.contentType || "").toLowerCase()] || "";

  if (originalName) {
    return originalName.includes(".") ? originalName : `${originalName}${extFromMime}`;
  }

  return `attachment-${uid}-${index}${extFromMime || ""}`;
};

const ATTACHMENTS_DIR = path.join(process.cwd(), "uploads", "attachments");

const saveAttachment = async (attachment, uid, index) => {
  if (!attachment?.content || attachment.content.length === 0) {
    console.log("Skipping empty attachment:", attachment);
    return null;
  }

  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });

  const filename = `${uid}-${index}-${getAttachmentFilename(attachment, uid, index)}`;
  const filePath = path.join(ATTACHMENTS_DIR, filename);

  const buffer = Buffer.isBuffer(attachment.content)
    ? attachment.content
    : Buffer.from(attachment.content);

  await fs.writeFile(filePath, buffer);

  return {
    originalName: attachment?.filename || attachment?.name || filename,
    filename,
    mimeType: attachment?.contentType || "application/octet-stream",
    size: buffer.length,
    path: filePath,
    url: `http://localhost:5000/uploads/attachments/${filename}`, // 🔥 IMPORTANT
    cid: attachment?.cid || "",
    contentDisposition: attachment?.contentDisposition || "",
  };
};

const buildReplyText = (senderName, bodyText) => {
  const cleanBody = (bodyText || "").trim();
  const footerLines = [...new Set([ASSISTANT_NAME, ASSISTANT_ROLE, COMPANY_NAME].filter(Boolean))];

  return [
    `Dear ${senderName},`,
    "",
    cleanBody,
    "",
    "Best regards,",
    ...footerLines,
  ].join("\n");
};

const resolveImapHost = (emailAddress) => {
  const domain = (emailAddress || "").split("@")[1]?.toLowerCase() || "";

  if (domain.includes("gmail.com")) {
    return IMAP_HOST_GMAIL;
  }

  if (domain.includes("yahoo.com")) {
    return IMAP_HOST_YAHOO;
  }

  return process.env.IMAP_HOST || IMAP_HOST_GMAIL;
};

const getProviderFromEmail = (emailAddress) => {
  const domain = (emailAddress || "").split("@")[1]?.toLowerCase() || "";

  if (domain.includes("yahoo")) {
    return "yahoo";
  }

  return "gmail";
};

const resolveSmtpConfig = (emailAddress) => {
  const provider = getProviderFromEmail(emailAddress);

  if (provider === "yahoo") {
    return {
      host: process.env.SMTP_HOST_YAHOO || "smtp.mail.yahoo.com",
      port: Number(process.env.SMTP_HOST_PORT || 465),
      secure: true,
    };
  }

  return {
    host: process.env.SMTP_HOST_GMAIL || "smtp.gmail.com",
    port: Number(process.env.SMTP_HOST_PORT || 465),
    secure: true,
  };
};

const createImapClient = ({ emailAddress, password, keepalive = false }) =>
  new Imap({
    user: emailAddress,
    password: normalizePassword(password),
    host: resolveImapHost(emailAddress),
    port: IMAP_HOST_PORT,
    tls: true,
    keepalive,
    authTimeout: 30000,
    connTimeout: 30000,
    tlsOptions: {
      rejectUnauthorized: !IMAP_ALLOW_SELF_SIGNED,
    },
  });

const createSmtpTransporter = ({ emailAddress, password }) =>
  nodemailer.createTransport({
    ...resolveSmtpConfig(emailAddress),
    auth: {
      user: emailAddress,
      pass: normalizePassword(password),
    },
  });

export const verifyMailboxCredentials = async ({ emailAddress, password }) =>
  new Promise((resolve, reject) => {
    const imap = createImapClient({ emailAddress, password });

    const cleanup = () => {
      imap.removeAllListeners("ready");
      imap.removeAllListeners("error");
      imap.removeAllListeners("end");
    };

    imap.once("ready", async () => {
      try {
        await openInbox(imap);
        cleanup();
        imap.end();
        resolve(true);
      } catch (err) {
        cleanup();
        imap.end();
        reject(err);
      }
    });

    imap.once("error", (err) => {
      cleanup();
      reject(err);
    });

    try {
      imap.connect();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });

export const openInbox = (imap) =>
  new Promise((resolve, reject) => {
    imap.openBox("INBOX", (err, box) => {
      if (err) {
        return reject(err);
      }

      resolve(box);
    });
  });

const markSeen = (imap, uid) =>
  new Promise((resolve, reject) => {
    imap.addFlags(uid, "\\Seen", (err) => {
      if (err) {
        return reject(err);
      }

      resolve();
    });
  });

const fetchUnseenEmails = async (imap, emailAddress, password) => {
  const transporter = createSmtpTransporter({ emailAddress, password });
  const uids = await new Promise((resolve, reject) => {
    imap.search(["UNSEEN"], (err, results) => {
      if (err) {
        return reject(err);
      }

      resolve(results || []);
    });
  });

  if (!uids.length) {
    console.log("No unseen emails found.");
    return 0;
  }

  const tasks = [];
  const fetch = imap.fetch(uids, {
    bodies: [""],
    markSeen: false,
  });

  fetch.on("message", (msg) => {
    let uid = null;
    let rawBody = "";

    msg.on("attributes", (attrs) => {
      uid = attrs.uid;
    });

    msg.on("body", (stream) => {
      stream.on("data", (chunk) => {
        rawBody += chunk.toString("utf8");
      });
    });

    msg.once("end", () => {
      tasks.push(
        (async () => {
          if (!uid || !rawBody) {
            return;
          }

          const parsed = await simpleParser(rawBody);
          const fromEmail = parsed.from?.value?.[0]?.address;
          const senderName = formatSenderName(parsed.from, fromEmail);
          const messageId = normalizeMessageId(parsed.messageId) || String(uid);
          const inReplyToIds = extractMessageIds(parsed.inReplyTo);
          const referenceIds = extractMessageIds(parsed.references);
          const threadMatch =
            inReplyToIds.length || referenceIds.length
              ? await Email.findOne({
                  messageId: { $in: [...inReplyToIds, ...referenceIds] },
                  $or: [{ sender: emailAddress }, { receiver: emailAddress }],
                }).sort({ createdAt: -1 })
              : null;
          const threadId = threadMatch?.threadId || messageId;

          if (!fromEmail) {
            await markSeen(imap, uid);
            return;
          }

          const subject = parsed.subject || "No Subject";
          const visibleBody = stripQuotedReplyText(parsed.text || "");

          const exists = await Email.findOne({ messageId, receiver: emailAddress });
          if (exists) {
            console.log(`Duplicate email skipped: ${messageId}`);
            await markSeen(imap, uid);
            return;
          }

          const attachments = await Promise.all(
            (parsed.attachments || []).map((attachment, index) =>
              saveAttachment(attachment, uid, index)
            )
          );
          console.log('attachments>>>>>>>>>', attachments);
          const savedAttachments = attachments.filter(Boolean);
          console.log('savedAttachments>>>>>>>>', savedAttachments);

          await Email.create({
            subject,
            sender: fromEmail,
            receiver: emailAddress,
            content: visibleBody || parsed.text || "",
            isInbound: true,
            threadId,
            messageId,
            inReplyTo: inReplyToIds[0] || "",
            references: referenceIds,
            attachments: savedAttachments,
          });

          const blockReason = getAutoReplyBlockReason({
            email: fromEmail,
            subject,
            body: visibleBody,
            mailboxEmail: emailAddress,
          });

          if (blockReason) {
            console.log(`Skipping auto-reply for ${fromEmail}: ${blockReason}`);
            await markSeen(imap, uid);
            return;
          }

          const alreadyRepliedToThisMessage = await Email.exists({
            isInbound: false,
            aiGenerated: true,
            inReplyTo: messageId,
            sender: emailAddress,
            receiver: fromEmail,
          });

          if (alreadyRepliedToThisMessage) {
            console.log(`Skipping duplicate auto-reply for inbound message: ${messageId}`);
            await markSeen(imap, uid);
            return;
          }

          const replyText = await generateAIReply(
            visibleBody || parsed.text || subject,
            subject || "general",
            savedAttachments
          );
          const fullReplyText = buildReplyText(senderName, replyText);

          const sendInfo = await transporter.sendMail({
            from: emailAddress,
            to: fromEmail,
            subject: `Re: ${subject}`,
            text: fullReplyText,
            inReplyTo: formatMessageIdHeader(messageId),
            references: formatMessageIdHeader([...referenceIds, messageId]),
          });

          const outgoingMessageId = normalizeMessageId(sendInfo?.messageId);

          await Email.create({
            subject: `Re: ${subject}`,
            sender: emailAddress,
            receiver: fromEmail,
            content: fullReplyText,
            isInbound: false,
            aiGenerated: true,
            threadId,
            messageId: outgoingMessageId || `${messageId}-reply`,
            inReplyTo: messageId,
            references: [...referenceIds, messageId].filter(Boolean),
          });

          await markSeen(imap, uid);
          console.log(`Processed email: ${subject}`);
        })().catch((err) => {
          console.error("Message processing error:", err.message);
        })
      );
    });
  });

  await new Promise((resolve, reject) => {
    fetch.once("error", reject);
    fetch.once("end", resolve);
  });

  await Promise.all(tasks);
  return tasks.length;
};

export async function connectToImap(config, jsonData) {
  return new Promise((resolve, reject) => {
    const emailAddress = String(config?.emailAddress || "").trim().toLowerCase();
    const password = normalizePassword(jsonData?.password);

    if (!emailAddress || !password) {
      reject(new Error("Email address and app password are required."));
      return;
    }

    const imap = createImapClient({ emailAddress, password, keepalive: true });

    let intervalId = null;
    let stopTimer = null;
    let isFetching = false;
    let settled = false;

    const clearTimers = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }

      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
    };

    const finishResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolve(value);
    };

    const finishReject = (err) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      reject(err);
    };

    const stopSession = () => {
      clearTimers();

      try {
        imap.end();
      } catch {
        // Ignore disconnect errors during logout cleanup.
      }

      finishResolve(false);
    };

    if (typeof config?.onSessionStart === "function") {
      config.onSessionStart({ stop: stopSession });
    }

    const pollInbox = async () => {
      if (isFetching) {
        return;
      }

      isFetching = true;

      try {
        await fetchUnseenEmails(imap, emailAddress, password);
      } finally {
        isFetching = false;
      }
    };

    imap.once("ready", async () => {
      try {
        console.log(`IMAP connected for: ${emailAddress}`);
        await openInbox(imap);
        console.log(`Inbox opened for: ${emailAddress}`);

        await pollInbox();
        intervalId = setInterval(pollInbox, FETCH_INTERVAL_MS);

        // stopTimer = setTimeout(() => {
        //   imap.end();
        //   finishResolve(true);
        // }, SESSION_MS);
      } catch (err) {
        imap.end();
        finishReject(err);
      }
    });

    imap.once("error", (err) => {
      console.error(`IMAP Error for ${emailAddress}:`, err.message);
      finishReject(err);
    });

    // imap.once("end", () => {
    //   console.log(`IMAP disconnected for: ${emailAddress}`);
    // });

    try {
      imap.connect();
    } catch (err) {
      finishReject(err);
    }
  });
}

const activeMailboxSessions = new Map();

export function startMailboxSession(account) {
  const emailAddress = String(account?.emailAddress || "").trim().toLowerCase();
  const password = normalizePassword(account?.password);

  if (!emailAddress || !password) {
    return false;
  }

  if (activeMailboxSessions.has(emailAddress)) {
    console.log(`Mailbox session already running for: ${emailAddress}`);
    return false;
  }

  let stopSession = null;
  const session = connectToImap(
    {
      emailAddress,
      onSessionStart: ({ stop }) => {
        stopSession = stop;
      },
    },
    {
      password,
    }
  )
    .catch((err) => {
      console.error(`Mailbox session error for ${emailAddress}:`, err.message);
    })
    .finally(() => {
      activeMailboxSessions.delete(emailAddress);
    });

  activeMailboxSessions.set(emailAddress, {
    session,
    stop: () => {
      if (typeof stopSession === "function") {
        stopSession();
      }
    },
  });
  return true;
}

export function stopMailboxSession(emailAddress) {
  const normalizedEmail = String(emailAddress || "").trim().toLowerCase();
  const activeSession = activeMailboxSessions.get(normalizedEmail);

  if (!activeSession) {
    return false;
  }

  activeSession.stop();
  activeMailboxSessions.delete(normalizedEmail);
  console.log(`Mailbox session stopped for: ${normalizedEmail}`);
  return true;
}

export async function imapSmtpInboxHandler() {
  const linkedAccounts = await EmailAccount.find({
    email: { $exists: true, $ne: "" },
    emailPassword: { $exists: true, $ne: "" },
  }).lean();

  const accounts = linkedAccounts.map((account) => ({
    emailAddress: account.email,
    password: account.emailPassword,
  }));

  if (!accounts.length) {
    console.log("No mailbox accounts configured for AI reply polling.");
    return;
  }

  accounts.forEach(startMailboxSession);
}

export function startEmailPolling() {
  void imapSmtpInboxHandler().catch((err) => {
    console.error("Email polling error:", err.message);
  });
}

export default imapSmtpInboxHandler;

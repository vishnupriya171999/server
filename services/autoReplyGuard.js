const NO_REPLY_PATTERNS = [
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
];

const BLOCKED_DOMAIN_PATTERNS = [
  ".gov",
  ".nic.in",
  "bank",
  "otp",
  "alert",
];

const ALLOWED_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "hotmail.com",
];

const SYSTEM_MAIL_PATTERNS = [
  "otp",
  "verification code",
  "verify your",
  "do not reply",
  "automated message",
  "security alert",
  "login alert",
  "transaction alert",
  "password reset",
  "one-time password",
];

const getDomain = (email) => String(email || "").toLowerCase().split("@")[1] || "";

export const stripQuotedReplyText = (body = "") => {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const quoteStartIndex = lines.findIndex((line) => {
    const lower = line.trim().toLowerCase();

    return (
      lower.startsWith(">") ||
      lower.startsWith("on ") && lower.includes(" wrote:") ||
      lower.includes("original message") ||
      lower.startsWith("from:") ||
      lower.startsWith("sent:") ||
      lower.startsWith("to:") ||
      lower.startsWith("subject:")
    );
  });

  const visibleLines = quoteStartIndex >= 0 ? lines.slice(0, quoteStartIndex) : lines;
  return visibleLines.join("\n").trim() || String(body || "").trim();
};

export const isNoReplyEmail = (email) => {
  const lower = String(email || "").toLowerCase();
  return NO_REPLY_PATTERNS.some((pattern) => lower.includes(pattern));
};

export const isBlockedDomain = (email) => {
  const domain = getDomain(email);
  return BLOCKED_DOMAIN_PATTERNS.some((block) => domain.includes(block));
};

export const isAllowedUserEmail = (email) => {
  const domain = getDomain(email);
  return ALLOWED_DOMAINS.includes(domain);
};

export const isSystemMail = (subject = "", body = "") => {
  const text = `${subject} ${stripQuotedReplyText(body)}`.toLowerCase();
  return SYSTEM_MAIL_PATTERNS.some((pattern) => text.includes(pattern));
};

export const getAutoReplyBlockReason = ({ email, subject = "", body = "", mailboxEmail = "" }) => {
  if (!email) {
    return "missing sender email";
  }

  if (mailboxEmail && String(email).toLowerCase() === String(mailboxEmail).toLowerCase()) {
    return "sender is connected mailbox";
  }

  if (isNoReplyEmail(email)) {
    return "no-reply sender";
  }

  if (isBlockedDomain(email)) {
    return "blocked domain";
  }

  if (!isAllowedUserEmail(email)) {
    return "sender domain is not allowed";
  }

  if (isSystemMail(subject, body)) {
    return "system or verification mail";
  }

  return "";
};

export const shouldAutoReply = (args) => !getAutoReplyBlockReason(args);

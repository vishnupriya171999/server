import crypto from "crypto";
import express from "express";
import {
  startMailboxSession,
  stopMailboxSession,
  verifyMailboxCredentials,
} from "../emailProcessor.js";
import EmailAccount from "../models/EmailAccount.js";
import User from "../models/User.js";

const router = express.Router();

const TOKEN_TTL_MS = Number(process.env.SESSION_MS || 300000);

const getTokenSecret = () =>
  process.env.AUTH_TOKEN_SECRET ||
  process.env.GROQ_API_KEY ||
  process.env.EMAIL_APP_PASSWORD ||
  "dev-auth-secret";

const encodeBase64Url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const signPayload = (payload) =>
  crypto
    .createHmac("sha256", getTokenSecret())
    .update(payload)
    .digest("base64url");

const createToken = (user) => {
  const payload = encodeBase64Url({
    sub: String(user._id),
    email: user.email,
    exp: Date.now() + TOKEN_TTL_MS,
  });

  return `${payload}.${signPayload(payload)}`;
};

const readToken = (authorization = "") => {
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  const [payload, signature] = token.split(".");
  if (!payload || !signature || signature !== signPayload(payload)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.exp > Date.now() ? parsed : null;
  } catch {
    return null;
  }
};

const getProviderFromEmail = (email) => {
  const domain = email.split("@")[1] || "";

  if (domain.includes("yahoo")) {
    return "yahoo";
  }

  return "gmail";
};

const findOrCreateUser = async (email) =>
  User.findOneAndUpdate(
    { email },
    {
      $set: {
        provider: getProviderFromEmail(email),
      },
      $setOnInsert: {
        email,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

const linkEmailAccount = async ({ user, email, password }) =>
  EmailAccount.findOneAndUpdate(
    {
      userId: user._id,
      email,
    },
    {
      $set: {
        emailPassword: password,
        provider: getProviderFromEmail(email),
      },
      $setOnInsert: {
        userId: user._id,
        email,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

const authResponse = (user) => ({
  token: createToken(user),
  user: {
    ...user.toSafeObject(),
    username: user.email,
  },
});

const getAuthenticatedUser = async (authorization) => {
  const payload = readToken(authorization || "");
  if (!payload?.sub) {
    return null;
  }

  return User.findById(payload.sub);
};

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body.email || req.body.identifier || "").trim().toLowerCase();
    const password = String(req.body.password || "").trim();

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }

    try {
      await verifyMailboxCredentials({ emailAddress: email, password });
    } catch (err) {
      return res.status(401).json({
        message:
          "Mailbox login failed. Use a valid Gmail/Yahoo email and app password with IMAP enabled.",
        detail: err.message,
      });
    }

    const user = await findOrCreateUser(email);
    const account = await linkEmailAccount({ user, email, password });
    startMailboxSession({ emailAddress: account.email, password: account.emailPassword });

    return res.status(200).json(authResponse(user));
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.get("/me", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req.headers.authorization);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized." });
    }

    return res.status(200).json({ user: authResponse(user).user });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req.headers.authorization);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized." });
    }

    const accounts = await EmailAccount.find({ userId: user._id }).lean();
    await EmailAccount.deleteMany({ userId: user._id });

    accounts.forEach((account) => {
      stopMailboxSession(account.email);
    });

    return res.status(200).json({
      message: "Mailbox disconnected and session cleared.",
      disconnectedAccounts: accounts.map((account) => account.email),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

export default router;

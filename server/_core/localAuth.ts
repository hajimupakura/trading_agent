import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

// ---------------------------------------------------------------------------
// Password hashing — Node.js built-in crypto.scrypt (no bcrypt dependency)
// ---------------------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(hash, "hex"));
}

function generateResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerLocalAuthRoutes(app: Express) {
  // POST /api/auth/register
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const { email, password, name } = req.body as {
      email?: string;
      password?: string;
      name?: string;
    };

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const normalised = email.trim().toLowerCase();
    const openId = `local:${normalised}`;

    const existing = await db.getUserByOpenId(openId);
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const passwordHash = hashPassword(password);
    await db.upsertUser({
      openId,
      name: name?.trim() || normalised.split("@")[0],
      email: normalised,
      loginMethod: "email",
      passwordHash,
      lastSignedIn: new Date(),
    });

    const sessionToken = await sdk.createSessionToken(openId, {
      name: name?.trim() || normalised.split("@")[0],
      expiresInMs: ONE_YEAR_MS,
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
    res.json({ success: true });
  });

  // POST /api/auth/login
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const normalised = email.trim().toLowerCase();
    const openId = `local:${normalised}`;
    const user = await db.getUserByOpenId(openId);

    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    await db.upsertUser({ openId, lastSignedIn: new Date() });

    const sessionToken = await sdk.createSessionToken(openId, {
      name: user.name || normalised,
      expiresInMs: ONE_YEAR_MS,
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
    res.json({ success: true });
  });

  // POST /api/auth/forgot-password
  app.post("/api/auth/forgot-password", async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };

    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    const normalised = email.trim().toLowerCase();
    const openId = `local:${normalised}`;
    const user = await db.getUserByOpenId(openId);

    // Always respond with success to avoid email enumeration
    if (!user) {
      res.json({ success: true, message: "If that account exists, a reset link has been generated." });
      return;
    }

    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await db.setResetToken(openId, token, expiresAt);

    // Return the reset link directly (self-hosted — no email service needed)
    const origin = `${req.protocol}://${req.get("host")}`;
    const resetLink = `${origin}/reset-password?token=${token}`;

    res.json({ success: true, resetLink });
  });

  // POST /api/auth/reset-password
  app.post("/api/auth/reset-password", async (req: Request, res: Response) => {
    const { token, password } = req.body as { token?: string; password?: string };

    if (!token || !password) {
      res.status(400).json({ error: "Token and password are required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    const user = await db.getUserByResetToken(token);
    if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
      res.status(400).json({ error: "Reset link is invalid or has expired" });
      return;
    }

    const passwordHash = hashPassword(password);
    await db.upsertUser({
      openId: user.openId,
      passwordHash,
      resetToken: null,
      resetTokenExpiresAt: null,
      lastSignedIn: new Date(),
    });

    const sessionToken = await sdk.createSessionToken(user.openId, {
      name: user.name || user.email || "",
      expiresInMs: ONE_YEAR_MS,
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
    res.json({ success: true });
  });
}

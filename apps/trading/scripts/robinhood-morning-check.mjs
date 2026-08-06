#!/usr/bin/env node
// Morning health check for the Robinhood MCP connection.
// Exit codes: 0 = healthy, 2 = reconnect needed (run the localhost connect flow), 1 = unexpected error.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_URL = "https://agent.robinhood.com/mcp/trading";
const TOKEN_URL = "https://api.robinhood.com/oauth2/token/";

function loadEnv() {
  const file = join(appDir, ".env.local");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      const value = m[2].replace(/^"(.*)"$/, "$1");
      // Vercel writes "[SENSITIVE]" placeholders for values it refuses to export.
      if (value === "[SENSITIVE]") continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

function cryptoKey() {
  const value = process.env.BROKER_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("BROKER_TOKEN_ENCRYPTION_KEY is not configured (run: vercel env pull .env.local)");
  const decoded = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error("BROKER_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return decoded;
}
function decrypt(value) {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Invalid encrypted broker credential");
  const d = createDecipheriv("aes-256-gcm", cryptoKey(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(encrypted, "base64url")), d.final()]).toString("utf8");
}
function encrypt(value) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const encrypted = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase credentials missing (run: vercel env pull .env.local)");
  return { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

async function getConnection() {
  const { url, headers } = supabase();
  const res = await fetch(`${url}/rest/v1/broker_connections?broker=eq.robinhood&select=user_id,status,oauth_client_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at&limit=1`, { headers });
  if (!res.ok) throw new Error(`Supabase query failed (${res.status})`);
  return (await res.json())[0] ?? null;
}

async function updateConnection(userId, patch) {
  const { url, headers } = supabase();
  const res = await fetch(`${url}/rest/v1/broker_connections?user_id=eq.${userId}&broker=eq.robinhood`, { method: "PATCH", headers, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`Supabase update failed (${res.status})`);
}

async function refreshToken(row) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: decrypt(row.refresh_token_ciphertext),
    client_id: row.oauth_client_id,
    resource: MCP_URL,
  });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Token refresh failed (${res.status})${body?.error_description ? `: ${body.error_description}` : body?.error ? `: ${body.error}` : ""}`);
  await updateConnection(row.user_id, {
    access_token_ciphertext: encrypt(body.access_token),
    refresh_token_ciphertext: body.refresh_token ? encrypt(body.refresh_token) : row.refresh_token_ciphertext,
    token_expires_at: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
    status: "connected",
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  return body.access_token;
}

function parseMcp(text) {
  if (!text.trim()) return null;
  if (text.trim().startsWith("{")) return JSON.parse(text);
  const data = text.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).filter(Boolean).at(-1);
  return data ? JSON.parse(data) : null;
}
async function rpc(token, body, sessionId) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Robinhood MCP call failed (${res.status})`);
  const payload = parseMcp(text);
  if (payload?.error) throw new Error(payload.error.message ?? "Robinhood MCP error");
  return { payload, sessionId: res.headers.get("mcp-session-id") ?? sessionId };
}

async function verifyMcp(token) {
  const init = await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "velocity-morning-check", version: "1.0.0" } } });
  await rpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  const listed = await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId);
  return (listed.payload?.result?.tools ?? []).length;
}

async function main() {
  loadEnv();
  const row = await getConnection();
  if (!row || row.status !== "connected") {
    console.log(`✗ Robinhood is not connected${row ? ` (status: ${row.status})` : ""}.`);
    process.exit(2);
  }
  let token;
  const expiresSoon = row.token_expires_at && Date.parse(row.token_expires_at) <= Date.now() + 10 * 60 * 1000;
  if (expiresSoon) {
    if (!row.refresh_token_ciphertext) { console.log("✗ Access token expired and no refresh token stored."); process.exit(2); }
    try {
      token = await refreshToken(row);
      console.log("↻ Access token refreshed.");
    } catch (err) {
      console.log(`✗ Token refresh failed: ${err.message}`);
      process.exit(2);
    }
  } else {
    token = decrypt(row.access_token_ciphertext);
  }
  try {
    const toolCount = await verifyMcp(token);
    console.log(`✓ Robinhood connection healthy — MCP reachable, ${toolCount} tools available.`);
    if (row.token_expires_at) console.log(`  Token expires: ${row.token_expires_at}`);
  } catch (err) {
    // Live check failed with a non-expired token; try one refresh before giving up.
    if (row.refresh_token_ciphertext && !expiresSoon) {
      try {
        token = await refreshToken(row);
        const toolCount = await verifyMcp(token);
        console.log(`✓ Robinhood connection healthy after refresh — ${toolCount} tools available.`);
        return;
      } catch (retryErr) {
        console.log(`✗ Robinhood MCP unreachable after refresh: ${retryErr.message}`);
        process.exit(2);
      }
    }
    console.log(`✗ Robinhood MCP check failed: ${err.message}`);
    process.exit(2);
  }
}

main().catch(err => { console.error(`Unexpected error: ${err.message}`); process.exit(1); });

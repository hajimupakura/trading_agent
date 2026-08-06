#!/usr/bin/env node
// Local OAuth forwarder. Robinhood only issues auth codes to localhost redirect
// URIs, so the browser lands here after consent; this bounces the callback —
// untouched query string and all — to the deployed app, which holds the secrets
// and completes the token exchange. No credentials ever live on this machine.
import { createServer } from "node:http";

const APP_URL = process.env.VELOCITY_APP_URL ?? "https://trading-agent-mocha.vercel.app";
const PORT = Number(process.env.PORT ?? 3000);
const CALLBACK_PATH = "/api/brokers/robinhood/callback";

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Velocity OAuth forwarder is running. Waiting for the Robinhood callback...\n");
    return;
  }
  const target = `${APP_URL}${CALLBACK_PATH}${url.search}`;
  res.writeHead(302, { Location: target });
  res.end();
  console.log(`✓ Callback received — forwarded to ${APP_URL}${CALLBACK_PATH}`);
  // Give the redirect a moment to leave, then exit so the wrapper script can continue.
  setTimeout(() => server.close(() => process.exit(0)), 1500);
});

server.listen(PORT, () => {
  console.log(`Forwarder listening on http://localhost:${PORT} -> ${APP_URL}`);
  console.log("Complete the Robinhood connect in your browser; this exits automatically afterwards.");
});

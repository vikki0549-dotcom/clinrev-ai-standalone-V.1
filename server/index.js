// ClinRev standalone server: serves the app behind OIDC auth and provides the
// backend for public/runtime/claude-shim.js.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import compression from "compression";
import { config, validateConfig } from "./config.js";
import { log, errInfo } from "./log.js";

try { validateConfig(); } catch (e) { console.error(e.message); process.exit(1); }

const db = await import("./db.js");
const { sessionMiddleware, sessionTimeouts, requireAuth, csrf, authRouter } = await import("./auth.js");
const { apiRouter, closeAllStreams } = await import("./api.js");
const { aiRouter } = await import("./ai/index.js");
const { page } = await import("./pages.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const INDEX = path.join(PUBLIC, "index.html");

/* -------- CSP: hash every inline <script> in index.html at startup -------- */
const indexHtml = fs.readFileSync(INDEX, "utf8");
const scriptHashes = [];
for (const m of indexHtml.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (m[1] && /\ssrc\s*=/.test(m[1])) continue;
  scriptHashes.push(`'sha256-${crypto.createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
}
if (!scriptHashes.length) log.warn("no inline scripts found in index.html");
if (!fs.existsSync(path.join(PUBLIC, "vendor"))) log.warn("public/vendor is missing: run `npm run vendor` (file import/export features will fail)");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", /^\d+$/.test(String(config.trustProxy)) ? Number(config.trustProxy) : config.trustProxy);

// Health check: no auth, no session, no PHI.
app.get("/healthz", async (req, res) => {
  try {
    await db.pool.query("SELECT 1");
    res.set("Cache-Control", "no-store").json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", ...scriptHashes],
        "script-src-attr": ["'none'"],
        // The app uses style="" attributes and a <style> block, so inline styles are allowed (scripts are not).
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'"],
        "worker-src": ["'self'", "blob:"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
        ...(config.baseUrl.startsWith("https://") ? { "upgrade-insecure-requests": [] } : {}),
      },
    },
    strictTransportSecurity: config.baseUrl.startsWith("https://") ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false,
  })
);
app.use((req, res, next) => {
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  next();
});
app.use(
  compression({
    filter: (req, res) => {
      if (req.path === "/api/events" || req.path === "/api/ai/stream") return false;
      return compression.filter(req, res);
    },
  })
);

app.use(sessionMiddleware);
app.use(sessionTimeouts);
app.use(authRouter());

// Everything below requires a signed-in, authorized user.
app.use(requireAuth);
app.use("/api", csrf);
app.use(apiRouter());
app.use(aiRouter());
app.use("/api", (req, res) => res.status(404).json({ code: "not-found", message: "Unknown API route" }));

const sendIndex = (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(indexHtml);
};
app.get(["/", "/index.html"], sendIndex);
app.use("/vendor", express.static(path.join(PUBLIC, "vendor"), { index: false, immutable: true, maxAge: "30d", setHeaders: (res) => res.set("Cache-Control", "private, max-age=2592000, immutable") }));
app.use("/runtime", express.static(path.join(PUBLIC, "runtime"), { index: false, setHeaders: (res) => res.set("Cache-Control", "no-cache") }));
app.use((req, res) => res.status(404).type("html").send(page("Not found", "That page does not exist.", false, "/", "Open ClinRev")));

// Error handler (body too large, malformed JSON, unexpected errors). No PHI in logs.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log.error("unhandled error", errInfo(err));
  if (res.headersSent) return;
  if (req.path.startsWith("/api/")) {
    const code = err.type === "entity.too.large" ? (req.path.startsWith("/api/ai") ? "prompt_too_large" : "too-large") : err.type === "entity.parse.failed" ? "invalid-argument" : "internal";
    return res.status(status).json({ code, message: status === 413 ? "The request is too large." : status < 500 ? "Bad request." : "Something went wrong. Try again." });
  }
  res.status(status).type("html").send(page("Error", "Something went wrong. Try again."));
});

/* ------------------------------------------------------------- start */
await db.migrate();
await db.startListener();
const server = http.createServer(app);
server.keepAliveTimeout = 65_000; // above typical load balancer idle timeouts
server.headersTimeout = 66_000;
server.listen(config.port, () => {
  log.info("listening", { port: config.port, authMode: config.authMode, aiProvider: config.ai.provider, baseUrl: config.baseUrl });
  if (config.authMode === "dev") log.warn("AUTH_MODE=dev: anyone who can reach this port is signed in. Never expose it.");
});

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { sig });
  closeAllStreams();
  server.close();
  setTimeout(() => process.exit(0), 10_000).unref();
  await db.stopDb();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log.error("unhandledRejection", errInfo(e)));

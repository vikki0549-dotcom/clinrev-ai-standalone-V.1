// /api/ai (complete) and /api/ai/stream (streamed text). Requires auth + CSRF
// (mounted behind them). Prompts and replies are never logged (PHI).
import express from "express";
import { config } from "../config.js";
import { audit } from "../db.js";
import { log, errInfo } from "../log.js";
import { AiError, getProvider, mapError } from "./providers.js";

/* Per-user token bucket (per app instance). */
const buckets = new Map();
function take(userId) {
  const { rateCapacity: cap, ratePerMinute: rate } = config.ai;
  const now = Date.now();
  const b = buckets.get(userId) || { tokens: cap, at: now };
  b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60_000) * rate);
  b.at = now;
  buckets.set(userId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { const old = Date.now() - 3_600_000; for (const [k, b] of buckets) if (b.at < old) buckets.delete(k); }, 600_000).unref();

const IMG_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function buildRequest(body) {
  const { prompt, modelTier, images } = body || {};
  if (typeof prompt !== "string" || !prompt) throw new AiError("invalid_request", "Missing prompt.", 400);
  const content = [];
  const imgs = Array.isArray(images) ? images : [];
  if (imgs.length > config.ai.maxImages) throw new AiError("prompt_too_large", `Too many images (max ${config.ai.maxImages}).`, 413);
  for (const im of imgs) {
    const mediaType = IMG_TYPES.has(im?.mediaType) ? im.mediaType : "image/jpeg";
    const data = String(im?.data || "");
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new AiError("invalid_request", "Invalid image data.", 400);
    if (data.length * 0.75 > config.ai.maxImageBytes) throw new AiError("prompt_too_large", "An image is too large.", 413);
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  content.push({ type: "text", text: prompt });
  const model = modelTier === "quick" ? config.ai.modelQuick : config.ai.modelDefault;
  const maxTokens = Math.max(1, Math.min(Number(body.maxTokens) || config.ai.maxTokens, config.ai.maxTokens));
  return { model, maxTokens, content, nImages: imgs.length, tier: modelTier === "quick" ? "quick" : "default" };
}

// Abort the upstream call when the client disconnects.
function abortOnClose(req, res) {
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
  return ctl;
}

export function aiRouter() {
  const r = express.Router();
  const json = express.json({ limit: process.env.AI_BODY_LIMIT || "25mb" });

  r.get("/api/ai/limits", (req, res) => res.json({ images: { maxCount: config.ai.maxImages, maxBytes: config.ai.maxImageBytes } }));

  r.post("/api/ai", json, async (req, res) => {
    const ctl = abortOnClose(req, res);
    const t0 = Date.now();
    let meta = {};
    try {
      if (!take(req.user.id)) throw new AiError("rate_limited", "Too many AI requests. Wait a minute and try again.", 429);
      const q = buildRequest(req.body);
      meta = { tier: q.tier, images: q.nImages };
      const provider = await getProvider();
      const text = await provider.complete({ ...q, signal: ctl.signal });
      audit(req.user, "ai", null, req, { ...meta, stream: false });
      log.info("ai ok", { ...meta, ms: Date.now() - t0, outChars: text.length });
      res.json({ text });
    } catch (e0) {
      const e = mapError(e0, ctl.signal);
      if (e.code !== "aborted") log.warn("ai failed", { ...meta, code: e.code, ...errInfo(e0) });
      if (!res.headersSent && !ctl.signal.aborted) res.status(e.status).json({ code: e.code, message: e.message });
    }
  });

  // Streams newline-delimited SSE frames over the POST response:
  //   data: {"type":"text","delta":"..."}   ...   data: {"type":"done","text":"..."}
  //   data: {"type":"error","code":"...","message":"..."}
  r.post("/api/ai/stream", json, async (req, res) => {
    const ctl = abortOnClose(req, res);
    const t0 = Date.now();
    let meta = {};
    let started = false;
    const frame = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
    try {
      if (!take(req.user.id)) throw new AiError("rate_limited", "Too many AI requests. Wait a minute and try again.", 429);
      const q = buildRequest(req.body);
      meta = { tier: q.tier, images: q.nImages };
      const provider = await getProvider();
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
      started = true;
      const text = await provider.stream({ ...q, signal: ctl.signal, onDelta: (d) => frame({ type: "text", delta: d }) });
      frame({ type: "done", text });
      res.end();
      audit(req.user, "ai", null, req, { ...meta, stream: true });
      log.info("ai ok", { ...meta, stream: true, ms: Date.now() - t0, outChars: text.length });
    } catch (e0) {
      const e = mapError(e0, ctl.signal);
      if (e.code !== "aborted") log.warn("ai failed", { ...meta, stream: true, code: e.code, ...errInfo(e0) });
      if (ctl.signal.aborted) return;
      if (!started) return res.status(e.status).json({ code: e.code, message: e.message });
      frame({ type: "error", code: e.code, message: e.message });
      res.end();
    }
  });
  return r;
}

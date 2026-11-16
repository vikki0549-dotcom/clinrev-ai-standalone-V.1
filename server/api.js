// JSON API used by public/runtime/claude-shim.js: session info, document store,
// real-time change stream (SSE) and user directory.
import express from "express";
import { config } from "./config.js";
import * as db from "./db.js";
import { allowed, resolveMe } from "./rules.js";
import { authorizationProblem, levelFor } from "./auth.js";
import { log, errInfo } from "./log.js";

const shapeOf = (p) => p.split("/").map((s, i) => (i % 2 ? "<id>" : s)).join("/"); // for logs: no ids

function sendErr(res, e) {
  if (e instanceof db.DbError) return res.status(e.status).json({ code: e.code, message: e.message });
  if (e?.type === "entity.too.large") return res.status(413).json({ code: "too-large", message: "The record is too large to save." });
  log.error("api error", errInfo(e));
  return res.status(500).json({ code: "internal", message: "Something went wrong. Try again." });
}

// Resolves "me", validates the path and enforces the access rule.
function check(req, rawPath, kind, op) {
  const p = resolveMe(String(rawPath || ""), req.user);
  const segs = db.parsePath(p, kind);
  if (!allowed(req.user, segs, kind === "doc", op)) {
    db.audit(req.user, "denied", p, req, { op });
    throw new db.DbError("permission-denied", "You don't have permission to " + (op === "read" ? "read" : "save") + " this.", 403);
  }
  return segs.join("/");
}

/* ---------------- SSE fan-out ---------------- */
const conns = new Set(); // { res, user, sid, store }

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

db.changes.on("change", async ({ path, version, op }) => {
  if (!conns.size) return;
  let doc;
  try {
    doc = op === "delete" ? { exists: false, id: path.split("/").pop(), data: null, version } : await db.getDoc(path);
    if (!doc.exists) doc.version = Math.max(version, doc.version || 0);
  } catch (e) {
    log.warn("change fetch failed", errInfo(e));
    for (const c of conns) sse(c.res, "resync", {});
    return;
  }
  const segs = path.split("/");
  const msg = { path, collection: segs.slice(0, -1).join("/"), id: doc.id, exists: doc.exists, data: doc.data, version: doc.version };
  for (const c of conns) {
    try { if (allowed(c.user, segs, true, "read")) sse(c.res, "change", msg); } catch {}
  }
});
db.changes.on("resync", () => { for (const c of conns) sse(c.res, "resync", {}); });

// Periodically re-validate each stream's session (logout, idle/absolute timeout,
// de-authorization) and close streams whose session ended.
const IDLE_MS = config.idleTimeoutMin * 60_000;
const ABS_MS = config.absoluteTimeoutHours * 3_600_000;
setInterval(() => {
  for (const c of conns) {
    c.store.get(c.sid, (err, s) => {
      const now = Date.now();
      const ok = !err && s?.user && now - (s.lastActivity || 0) <= IDLE_MS && now - (s.createdAt || 0) <= ABS_MS && !authorizationProblem(s.user);
      if (!ok) { sse(c.res, "expired", {}); c.res.end(); conns.delete(c); }
      else c.user = { ...s.user, ...levelFor(s.user.email) };
    });
  }
}, 30_000).unref();
setInterval(() => { for (const c of conns) c.res.write(": ping\n\n"); }, 25_000).unref();

export function closeAllStreams() { for (const c of conns) { try { c.res.end(); } catch {} } conns.clear(); }

/* ---------------- routes ---------------- */
export function apiRouter() {
  const r = express.Router();
  const json = express.json({ limit: process.env.DB_BODY_LIMIT || "5mb" });

  r.get("/api/session", (req, res) => {
    const u = req.user;
    res.set("Cache-Control", "no-store").json({
      user: { id: u.id, name: u.name, email: u.email },
      isOwner: !!u.isOwner,
      canEdit: u.level === "admin",
      level: u.level,
      csrf: req.session.csrf,
      idleTimeoutMin: config.idleTimeoutMin,
    });
  });
  r.post("/api/session/ping", (req, res) => res.status(204).end());

  r.get("/api/db/doc", async (req, res) => {
    try {
      const p = check(req, req.query.path, "doc", "read");
      const d = await db.getDoc(p);
      db.audit(req.user, "read", p, req);
      res.set("Cache-Control", "no-store").json(d);
    } catch (e) { sendErr(res, e); }
  });

  r.get("/api/db/collection", async (req, res) => {
    try {
      const p = check(req, req.query.path, "collection", "read");
      const out = await db.listCollection(p);
      db.audit(req.user, "list", p, req, { n: out.docs.length });
      res.set("Cache-Control", "no-store").json(out);
    } catch (e) { sendErr(res, e); }
  });

  r.post("/api/db/doc", json, async (req, res) => {
    try {
      const { op, path, data } = req.body || {};
      if (!["set", "update", "delete"].includes(op)) throw new db.DbError("invalid-argument", "Unknown operation", 400);
      const p = check(req, path, "doc", "write");
      let out;
      if (op === "set") out = await db.setDoc(p, data, req.user.id);
      else if (op === "update") out = await db.updateDoc(p, data, req.user.id);
      else out = await db.deleteDoc(p);
      db.audit(req.user, op, p, req);
      log.debug("db write", { op, shape: shapeOf(p) });
      res.json({ ok: true, ...out });
    } catch (e) { sendErr(res, e); }
  });

  r.post("/api/db/add", json, async (req, res) => {
    try {
      const { path, data } = req.body || {};
      const p = check(req, path, "collection", "write");
      const out = await db.addDoc(p, data, req.user.id);
      db.audit(req.user, "create", p + "/" + out.id, req);
      res.json({ ok: true, ...out });
    } catch (e) { sendErr(res, e); }
  });

  r.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const c = { res, user: req.user, sid: req.sessionID, store: req.sessionStore };
    conns.add(c);
    sse(res, "hello", { at: Date.now() });
    req.on("close", () => conns.delete(c));
  });

  r.post("/api/users/profiles", json, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string").slice(0, 500) : [];
      const rows = ids.length ? await db.profiles(ids) : [];
      const out = {};
      for (const row of rows) out[row.id] = { name: row.name || "Someone", guest: false };
      res.json(out);
    } catch (e) { sendErr(res, e); }
  });

  r.get("/api/users/search", async (req, res) => {
    try {
      if (req.user.level !== "admin") throw new db.DbError("permission-denied", "Only administrators can search users.", 403);
      const q = String(req.query.q || "").slice(0, 100);
      res.set("Cache-Control", "no-store").json(await db.searchUsers(q));
    } catch (e) { sendErr(res, e); }
  });

  return r;
}

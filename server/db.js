// PostgreSQL access: pool, migrations, JSONB document store, audit log and
// LISTEN/NOTIFY fan-out of document changes across app instances.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";
import { log, errInfo } from "./log.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "doc_changes";

function sslOptions() {
  if (!config.databaseSsl) return undefined;
  if (config.databaseSsl === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ca: config.databaseCaFile ? fs.readFileSync(config.databaseCaFile, "utf8") : undefined };
}
const connOpts = () => ({ connectionString: config.databaseUrl, ssl: sslOptions() });

export const pool = new pg.Pool({ ...connOpts(), max: Number(process.env.DATABASE_POOL_MAX) || 10 });
pool.on("error", (e) => log.error("pg pool error", errInfo(e)));

/* ---------------- migrations ---------------- */
export async function migrate() {
  const dir = path.join(ROOT, "db/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727274)"); // one instance migrates at a time
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        log.info("migration applied", { migration: f });
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    c.release();
  }
}

/* ---------------- paths ---------------- */
const SEG_RE = /^[A-Za-z0-9_\-.@+:~]{1,200}$/;
export class DbError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
// Splits and validates a path. kind: "doc" (even #segments) or "collection" (odd).
export function parsePath(p, kind) {
  if (typeof p !== "string" || p.length > 1000) throw new DbError("invalid-argument", "Invalid path", 400);
  const segs = p.replace(/^\/+|\/+$/g, "").split("/");
  if (!segs.length || segs.some((s) => !SEG_RE.test(s) || s === "." || s === "..")) throw new DbError("invalid-argument", "Invalid path", 400);
  const isDoc = segs.length % 2 === 0;
  if (kind === "doc" && !isDoc) throw new DbError("invalid-argument", "Document paths need an even number of segments", 400);
  if (kind === "collection" && isDoc) throw new DbError("invalid-argument", "Collection paths need an odd number of segments", 400);
  return segs;
}
export const newId = () => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.randomBytes(20);
  let s = "";
  for (const x of b) s += A[x % 62];
  return s;
};

/* ---------------- documents ---------------- */
const isPlainObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const isDeleteSentinel = (v) => isPlainObject(v) && v.__delete__ === true && Object.keys(v).length === 1;
function stripSentinels(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!isDeleteSentinel(v)) out[k] = v;
  return out;
}

// asOf: the version counter before the read. A client treats a missing doc as
// "deleted at asOf", and keeps stream updates newer than asOf.
const asOf = async () => Number((await pool.query("SELECT last_value FROM doc_version_seq")).rows[0].last_value);

export async function getDoc(p) {
  const v0 = await asOf();
  const r = await pool.query("SELECT doc_id, data, version FROM documents WHERE path=$1", [p]);
  if (!r.rowCount) return { exists: false, id: p.split("/").pop(), data: null, version: v0 };
  return { exists: true, id: r.rows[0].doc_id, data: r.rows[0].data, version: Number(r.rows[0].version) };
}

export async function listCollection(col) {
  const v0 = await asOf();
  const r = await pool.query("SELECT doc_id, data, version FROM documents WHERE collection=$1 ORDER BY doc_id", [col]);
  return { asOf: v0, docs: r.rows.map((x) => ({ id: x.doc_id, data: x.data, version: Number(x.version) })) };
}

async function notify(client, p, version, op) {
  // Payload stays small (NOTIFY limit is 8000 bytes): receivers re-read the row.
  await client.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ p, v: version, op })]);
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function setDoc(p, data, userId) {
  if (!isPlainObject(data)) throw new DbError("invalid-argument", "Document data must be an object", 400);
  const segs = p.split("/");
  return tx(async (c) => {
    const v = Number((await c.query("SELECT nextval('doc_version_seq') AS v")).rows[0].v);
    await c.query(
      `INSERT INTO documents(path, collection, doc_id, data, version, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (path) DO UPDATE SET data=EXCLUDED.data, version=EXCLUDED.version, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [p, segs.slice(0, -1).join("/"), segs.at(-1), JSON.stringify(stripSentinels(data)), v, userId]
    );
    await notify(c, p, v, "set");
    return { id: segs.at(-1), version: v };
  });
}

// Shallow merge of top-level fields; {"__delete__":true} removes a field.
// Throws not-found when the document does not exist (Firestore semantics).
export async function updateDoc(p, patch, userId) {
  if (!isPlainObject(patch)) throw new DbError("invalid-argument", "Update data must be an object", 400);
  return tx(async (c) => {
    const r = await c.query("SELECT data FROM documents WHERE path=$1 FOR UPDATE", [p]);
    if (!r.rowCount) throw new DbError("not-found", "No document to update", 404);
    const data = r.rows[0].data || {};
    for (const [k, v] of Object.entries(patch)) {
      if (isDeleteSentinel(v)) delete data[k];
      else data[k] = v;
    }
    const v = Number((await c.query("SELECT nextval('doc_version_seq') AS v")).rows[0].v);
    await c.query("UPDATE documents SET data=$2, version=$3, updated_at=now(), updated_by=$4 WHERE path=$1", [p, JSON.stringify(data), v, userId]);
    await notify(c, p, v, "update");
    return { id: p.split("/").pop(), version: v };
  });
}

export async function deleteDoc(p) {
  return tx(async (c) => {
    const r = await c.query("DELETE FROM documents WHERE path=$1", [p]);
    const v = Number((await c.query("SELECT nextval('doc_version_seq') AS v")).rows[0].v);
    if (r.rowCount) await notify(c, p, v, "delete");
    return { existed: r.rowCount > 0, version: v };
  });
}

export async function addDoc(col, data, userId) {
  for (let i = 0; i < 3; i++) {
    const id = newId();
    const p = col + "/" + id;
    const exists = await pool.query("SELECT 1 FROM documents WHERE path=$1", [p]);
    if (exists.rowCount) continue;
    const r = await setDoc(p, data, userId);
    return { id, version: r.version };
  }
  throw new DbError("internal", "Could not allocate an id", 500);
}

/* ---------------- users ---------------- */
export async function upsertUser(u) {
  await pool.query(
    `INSERT INTO users(id, issuer, subject, email, name) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, last_login=now()`,
    [u.id, u.issuer, u.sub, u.email, u.name]
  );
}
export async function profiles(ids) {
  const r = await pool.query("SELECT id, name FROM users WHERE id = ANY($1::text[])", [ids]);
  return r.rows;
}
export async function searchUsers(q) {
  const like = "%" + String(q || "").replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  const r = await pool.query(
    "SELECT id, name, email FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY last_login DESC LIMIT 25",
    [like]
  );
  return r.rows;
}

/* ---------------- audit ---------------- */
export function audit(user, action, p, req, detail) {
  pool
    .query("INSERT INTO audit_log(user_id, email, action, path, ip, detail) VALUES ($1,$2,$3,$4,$5,$6)", [
      user?.id || null,
      user?.email || null,
      action,
      p || null,
      req?.ip || null,
      detail ? JSON.stringify(detail) : null,
    ])
    .catch((e) => log.error("audit write failed", errInfo(e)));
}

/* ---------------- change feed (LISTEN/NOTIFY) ---------------- */
// Emits "change" {path, version, op} for every committed write on any instance,
// and "resync" after the listener reconnects (changes may have been missed).
export const changes = new EventEmitter();
changes.setMaxListeners(0);

let listener = null;
let stopping = false;
export async function startListener() {
  let backoff = 500;
  const connect = async () => {
    if (stopping) return;
    const c = new pg.Client(connOpts());
    c.on("error", (e) => log.warn("pg listener error", errInfo(e)));
    c.on("end", () => {
      if (stopping) return;
      log.warn("pg listener disconnected; reconnecting");
      listener = null;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });
    try {
      await c.connect();
      await c.query("LISTEN " + CHANNEL);
      const wasReconnect = listener === null && startListener.started;
      listener = c;
      startListener.started = true;
      backoff = 500;
      c.on("notification", (m) => {
        try {
          const x = JSON.parse(m.payload);
          changes.emit("change", { path: x.p, version: x.v, op: x.op });
        } catch {}
      });
      if (wasReconnect) changes.emit("resync");
    } catch (e) {
      log.warn("pg listener connect failed", errInfo(e));
      c.removeAllListeners("end");
      try { await c.end(); } catch {}
      if (!startListener.started) throw e; // first start: fail fast
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  };
  await connect();
}
export async function stopDb() {
  stopping = true;
  try { await listener?.end(); } catch {}
  await pool.end().catch(() => {});
}

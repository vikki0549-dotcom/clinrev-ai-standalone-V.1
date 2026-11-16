#!/usr/bin/env node
// Imports data exported from the Claude-hosted artifact into the documents table.
//
//   node tools/import-artifact-export.js <export.json | export-dir/> [--dry-run] [--skip-user-keyed]
//
// Accepted inputs:
//   1. JSON file: { "<collectionPath>": { "<docId>": { ...data } } }
//        e.g. { "encounters": { "abc": {...} }, "data/users/u_123": { "mfa_jane": {...} } }
//   2. Directory of <collectionPath>/<docId>.json files
//        e.g. export/encounters/abc.json, export/settings/practice.json
//
// Idempotent: each document is upserted (replaced) by path. Uses DATABASE_URL.
// --skip-user-keyed skips members/* and data/users/*, which are keyed by the old
// Claude user ids and are not reachable by the new OIDC-derived ids anyway.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
const dry = args.includes("--dry-run");
const skipUserKeyed = args.includes("--skip-user-keyed");
if (!src) {
  console.error("usage: node tools/import-artifact-export.js <export.json|dir> [--dry-run] [--skip-user-keyed]");
  process.exit(2);
}

function fromJson(file) {
  const obj = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const [col, docs] of Object.entries(obj)) {
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) throw new Error(`"${col}" must map doc ids to objects`);
    for (const [id, data] of Object.entries(docs)) out.push([col.replace(/^\/+|\/+$/g, "") + "/" + id, data]);
  }
  return out;
}
function fromDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        const rel = path.relative(dir, p).split(path.sep).join("/").replace(/\.json$/, "");
        out.push([rel, JSON.parse(fs.readFileSync(p, "utf8"))]);
      }
    }
  };
  walk(dir);
  return out;
}

const items = fs.statSync(src).isDirectory() ? fromDir(src) : fromJson(src);
const { parsePath, setDoc, migrate, pool, audit } = await import("../server/db.js");

let n = 0, skipped = 0;
const counts = {};
try {
  if (!dry) await migrate();
  for (const [p, data] of items) {
    parsePath(p, "doc"); // throws on invalid path
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${p}: document data must be an object`);
    const top = p.split("/")[0];
    if (skipUserKeyed && (top === "members" || top === "data")) { skipped++; continue; }
    counts[top] = (counts[top] || 0) + 1;
    if (!dry) await setDoc(p, data, "import");
    n++;
  }
  if (!dry) audit({ id: "import", email: null }, "import", null, null, { documents: n });
  console.log(`${dry ? "Would import" : "Imported"} ${n} document(s)${skipped ? `, skipped ${skipped} user-keyed` : ""}:`, counts);
} catch (e) {
  console.error("Import failed:", e.message);
  process.exitCode = 1;
} finally {
  await new Promise((r) => setTimeout(r, 200)); // let the audit insert flush
  await pool.end();
}

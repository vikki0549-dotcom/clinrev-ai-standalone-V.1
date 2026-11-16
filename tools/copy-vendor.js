#!/usr/bin/env node
// Copies the exact browser builds the app loads from CDNs into public/vendor/.
// Sources are the pinned devDependencies in package.json (npm registry tarballs,
// integrity-checked by package-lock.json). Run after `npm ci`: npm run vendor
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public/vendor");

// [package, expected version, file inside package, destination under public/vendor]
const FILES = [
  ["pdfjs-dist", "3.11.174", "build/pdf.min.js", "pdfjs-3.11.174/pdf.min.js"],
  ["pdfjs-dist", "3.11.174", "build/pdf.worker.min.js", "pdfjs-3.11.174/pdf.worker.min.js"],
  ["docx", "8.5.0", "build/index.umd.js", "docx-8.5.0/index.umd.js"],
  ["mammoth", "1.6.0", "mammoth.browser.min.js", "mammoth-1.6.0/mammoth.browser.min.js"],
  ["qrcode-generator", "1.4.4", "qrcode.js", "qrcode-generator-1.4.4/qrcode.js"],
  ["xlsx", "0.18.5", "dist/xlsx.full.min.js", "xlsx-0.18.5/xlsx.full.min.js"],
];

let failed = false;
for (const [pkg, ver, file, dest] of FILES) {
  // Resolve via node_modules directly: some packages don't export ./package.json.
  const dir = path.join(ROOT, "node_modules", pkg);
  if (!fs.existsSync(path.join(dir, "package.json"))) { console.error(`missing package ${pkg}@${ver} (run npm ci, including devDependencies)`); failed = true; continue; }
  const got = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  if (got !== ver) { console.error(`${pkg}: expected ${ver}, installed ${got}`); failed = true; continue; }
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) { console.error(`${pkg}@${ver}: file ${file} not found`); failed = true; continue; }
  const to = path.join(OUT, dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(src, to);
  console.log(`vendored ${pkg}@${ver}/${file} -> public/vendor/${dest}`);
}
if (failed) process.exit(1);

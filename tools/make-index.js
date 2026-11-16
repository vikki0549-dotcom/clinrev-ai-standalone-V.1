#!/usr/bin/env node
// Regenerates public/index.html from an HTML file exported from Claude.
//
//   node tools/make-index.js <exported.html> [out=public/index.html]
//
// Applies ONLY these edits and leaves every other byte unchanged:
//   1. inserts <script src="/runtime/claude-shim.js"></script> right before the
//      app's main inline <script> (the one that calls window.claude.use)
//   2. rewrites the known CDN library URLs to self-hosted copies under /vendor/
// It fails (exit 1) if the export loads a CDN script it does not know how to
// self-host, or a library version differs from the one tools/copy-vendor.js
// vendors, so a new export can never silently pull code from a third party.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SHIM_TAG = '<script src="/runtime/claude-shim.js"></script>';

// Exact CDN URL -> self-hosted URL. Keep in sync with tools/copy-vendor.js.
export const URL_MAP = [
  ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/", "/vendor/pdfjs-3.11.174/"],
  ["https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js", "/vendor/docx-8.5.0/index.umd.js"],
  ["https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js", "/vendor/mammoth-1.6.0/mammoth.browser.min.js"],
  ["https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js", "/vendor/qrcode-generator-1.4.4/qrcode.js"],
  ["https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", "/vendor/xlsx-0.18.5/xlsx.full.min.js"],
];
const CDN_RE = /https:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|cdn\.sheetjs\.com|code\.jquery\.com|cdn\.tailwindcss\.com)\/[^\s"'`)]*/g;

export function transform(src) {
  let out = src;
  const changes = [];
  for (const [from, to] of URL_MAP) {
    const n = out.split(from).length - 1;
    if (n) { out = out.split(from).join(to); changes.push(`${n}x ${from} -> ${to}`); }
  }
  const left = [...new Set(out.match(CDN_RE) || [])];
  if (left.length) {
    throw new Error("Unmapped CDN URL(s) in export (add them to URL_MAP and tools/copy-vendor.js):\n  " + left.join("\n  "));
  }
  if (!out.includes(SHIM_TAG)) {
    // Find the main inline script: a bare <script> whose body references window.claude.
    const re = /<script>/g; let m, at = -1;
    while ((m = re.exec(out))) {
      const end = out.indexOf("</script>", m.index);
      if (end > 0 && out.slice(m.index, end).includes("window.claude")) { at = m.index; break; }
    }
    if (at < 0) throw new Error("Could not find the app's inline <script> that uses window.claude");
    out = out.slice(0, at) + SHIM_TAG + "\n" + out.slice(at);
    changes.push("inserted shim tag before main inline <script>");
  }
  return { html: out, changes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inFile = process.argv[2] || path.join(ROOT, "original/clinrev-ai.html");
  const outFile = process.argv[3] || path.join(ROOT, "public/index.html");
  try {
    const { html, changes } = transform(fs.readFileSync(inFile, "utf8"));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);
    console.log(`Wrote ${outFile}\n  ` + changes.join("\n  "));
  } catch (e) {
    console.error("make-index failed: " + e.message);
    process.exit(1);
  }
}

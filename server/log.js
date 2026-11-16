// Minimal structured JSON logger. Never pass PHI here: no prompts, record
// contents, patient names, or request bodies. Paths are logged only as
// "collection/<id>" shapes by callers when needed.
import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[config.logLevel] ?? 20;

function write(level, msg, fields) {
  if ((LEVELS[level] ?? 20) < min) return;
  const line = { t: new Date().toISOString(), level, msg, ...fields };
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (m, f) => write("debug", m, f),
  info: (m, f) => write("info", m, f),
  warn: (m, f) => write("warn", m, f),
  error: (m, f) => write("error", m, f),
};

// Safe error summary: class/name, status, code. Deliberately omits error.message
// for upstream AI errors, which can echo prompt fragments.
export const errInfo = (e) => ({ err: e?.name || "Error", status: e?.status, code: e?.code });

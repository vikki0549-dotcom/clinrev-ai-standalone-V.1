// Unit test for critical care (99291/99292) time rules in the app's E/M engine.
// Run: node test/critical-care.mjs
import { readFileSync } from "node:fs";
const h = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const src = h.slice(h.indexOf("const MDM_NAMES"), h.indexOf("function emCard"));
const api = new Function(src + "; return { emEngine, ccTimeInNote };")();
const base = { family: "ed", performedBy: "physician-qhp", problems: "high", data: "extensive", risk: "high", separateFromProcedure: true };
const run = (min, payer, before = false) => api.emEngine({ ...base, criticalCare: { documented: true, minutes: min, emBeforeCritical: before } }, false, payer);
const cases = [
  [25, "Commercial", false, { cc: false, em: true }],
  [45, "Commercial", false, { cc: true, add: 0, em: false }],
  [80, "Commercial", false, { cc: true, add: 1, em: false }],
  [80, "Medicare", false, { cc: true, add: 0, em: false }],
  [110, "Medicare", false, { cc: true, add: 1, em: false }],
  [140, "Commercial", false, { cc: true, add: 3, em: false }],
  [60, "Medicare", true, { cc: true, add: 0, em: true, mod25: true }],
];
let pass = 0;
for (const [min, payer, before, exp] of cases) {
  const r = run(min, payer, before), k = r.critical || {};
  const ok = !!k.billable === exp.cc && !!r.billable === exp.em && (!exp.cc || k.addOn === exp.add) && (exp.mod25 === undefined || k.modifier25 === exp.mod25);
  console.log(`${ok ? "PASS" : "FAIL"}  ${min} min ${payer}${before ? " (E/M before)" : ""}: ${k.billable ? `99291${k.modifier25 ? "-25" : ""} + 99292 x${k.addOn}` : "no critical care"}, E/M ${r.billable ? "billed" : "not billed"}`);
  if (ok) pass++;
}
const none = api.emEngine(base, false, "Commercial");
const okNone = !none.critical && none.code === "99285";
console.log(`${okNone ? "PASS" : "FAIL"}  no critical care documented: E/M ${none.code}`); if (okNone) pass++;
const notes = [["CRITICAL CARE TIME:   [45 minutes]", 45], ["Critical care time 110 min excluding procedures", 110], ["CRITICAL CARE TIME: [ ]", null]];
let extra = 0;
for (const [txt, want] of notes) { const r = api.ccTimeInNote(txt); const ok = (r ? r.minutes : null) === want; console.log(`${ok ? "PASS" : "FAIL"}  attestation "${txt}" -> ${r ? r.minutes + " min" : "none"}`); if (ok) extra++; }
const total = cases.length + 1 + notes.length; pass += extra;
console.log(`\n${pass}/${total} passed`); process.exit(pass === total ? 0 : 1);

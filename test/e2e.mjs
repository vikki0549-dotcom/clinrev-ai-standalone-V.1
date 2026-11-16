// End-to-end test (development only). Starts two app instances against one
// Postgres (to exercise LISTEN/NOTIFY fan-out), drives them with Playwright.
//
//   DATABASE_URL=postgres://... node test/e2e.mjs
//
// Instance A: AUTH_MODE=dev, AI_PROVIDER=mock (TEST-ONLY stub)
// Instance B: AUTH_MODE=dev, AI_PROVIDER=anthropic with no key (must fail cleanly)
// WARNING: wipes the documents table of the target database.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DATABASE_URL || "postgres://clinrev:clinrev@127.0.0.1:5432/clinrev";
const OUT = process.env.E2E_OUT || path.join(ROOT, "test/out");
fs.mkdirSync(OUT, { recursive: true });

function totp(b32) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of b32.toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(ctr).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
const results = [];
const ok = (name, cond, info = "") => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  - " + info : ""}`); };

function startServer(port, extra) {
  const env = {
    ...process.env, NODE_ENV: "development", PORT: String(port), DATABASE_URL: DB, AUTH_MODE: "dev",
    APP_BASE_URL: `http://localhost:${port}`, OWNER_EMAILS: "owner@example.com", DEV_USER_EMAIL: "owner@example.com",
    DEV_USER_NAME: "Olivia Owner", LOG_LEVEL: "info", ...extra,
  };
  const p = spawn(process.execPath, [path.join(ROOT, "server/index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  p.stdout.on("data", (d) => logs.push(String(d)));
  p.stderr.on("data", (d) => logs.push(String(d)));
  p.logs = logs;
  return p;
}
async function waitHealthy(port) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://localhost:${port}/healthz`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server on " + port + " did not start");
}

const pool = new pg.Pool({ connectionString: DB });
const A = startServer(3101, { AI_PROVIDER: "mock" });
const B_ENV = { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" };
let B = startServer(3102, B_ENV);
let browser;
try {
  await waitHealthy(3101);
  await waitHealthy(3102);
  await pool.query("DELETE FROM documents");
  await pool.query("DELETE FROM session");

  // --- unauthenticated access is redirected / refused
  let r = await fetch("http://localhost:3101/", { redirect: "manual" });
  ok("unauthenticated / redirects to /auth/login", r.status === 302 && /\/auth\/login/.test(r.headers.get("location")));
  r = await fetch("http://localhost:3101/vendor/xlsx-0.18.5/xlsx.full.min.js", { redirect: "manual" });
  ok("unauthenticated /vendor is not served", r.status === 302);
  r = await fetch("http://localhost:3101/api/db/collection?path=encounters");
  ok("unauthenticated API returns 401", r.status === 401);

  browser = await chromium.launch();
  const watch = (page, tag) => {
    const msgs = [];
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") msgs.push(`[${tag}] ${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => msgs.push(`[${tag}] pageerror: ${e.message}`));
    return msgs;
  };
  const cspProbe = () => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  };

  // --- Owner on instance A
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, acceptDownloads: true });
  const pA = await ctxA.newPage();
  await pA.addInitScript(cspProbe);
  const msgsA = watch(pA, "A");
  await pA.goto("http://localhost:3101/");
  ok("dev sign-in lands on the app", new URL(pA.url()).pathname === "/");
  await pA.waitForFunction(() => !document.body.innerText.includes("Loading workspace"), null, { timeout: 15000 });
  await pA.waitForTimeout(800);
  await pA.screenshot({ path: path.join(OUT, "owner-first-screen.png") });
  const textA = await pA.evaluate(() => document.body.innerText.slice(0, 400));
  ok("app got past 'Loading workspace…'", !/Loading workspace/.test(textA) && !/Open this page in claude\.ai/.test(textA), JSON.stringify(textA.slice(0, 120)));

  // The app's own in-app owner setup works against the backend (creds + private MFA doc + QR code)
  await pA.fill("#ow_login", "olivia.admin");
  await pA.fill("#ow_pw", "Correct-horse-42");
  await pA.fill("#ow_pw2", "Correct-horse-42");
  await pA.click("text=Create login and continue");
  await pA.waitForSelector("img[src^='data:image']", { timeout: 10000 }).catch(() => {});
  await pA.waitForTimeout(500);
  await pA.screenshot({ path: path.join(OUT, "owner-mfa-enroll.png") });
  // Finish enrollment with a real TOTP code computed from the displayed key.
  const hadQr = (await pA.$("img[src^='data:image']")) !== null;
  const key = (await pA.evaluate(() => (document.body.innerText.match(/enter this key:\s*([A-Z2-7 ]{16,})/) || [])[1] || "")).replace(/\s+/g, "");
  if (key) {
    await pA.fill("input[autocomplete='one-time-code'], input[placeholder='123456']", totp(key));
    await pA.click("text=Turn on two-step verification");
    await pA.waitForTimeout(1500);
    await pA.screenshot({ path: path.join(OUT, "owner-after-mfa.png") });
  }
  const doneBtn = await pA.$("text=I saved them, continue");
  if (doneBtn) { await doneBtn.click(); await pA.waitForTimeout(800); await pA.screenshot({ path: path.join(OUT, "owner-dashboard.png") }); }
  const credRow = await pool.query("SELECT path FROM documents WHERE path='creds/olivia.admin' OR path LIKE 'data/users/%/mfa_olivia.admin'");
  ok("in-app administrator setup saves creds + private MFA doc, shows QR", credRow.rowCount === 2 && hadQr, credRow.rows.map((r) => r.path.replace(/u_[^/]+/, "u_…")).join(", "));

  const sess = await pA.evaluate(async () => {
    const u = await window.claude.use("user");
    return { me: await u.me(), id: await u.id(), owner: await u.isOwner(), canEdit: await u.canEdit() };
  });
  ok("user.me/id/isOwner/canEdit", /^u_[A-Za-z0-9_-]{22}$/.test(sess.id) && sess.owner && sess.canEdit && sess.me.email === "owner@example.com", JSON.stringify(sess));

  // --- Second user (non-admin) on instance B (separate browser context)
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const pB = await ctxB.newPage();
  await pB.addInitScript(cspProbe);
  const msgsB = watch(pB, "B");
  await pB.goto("http://localhost:3102/auth/login?as=nurse@example.com");
  await pB.waitForFunction(() => !document.body.innerText.includes("Loading workspace"), null, { timeout: 15000 });
  const sessB = await pB.evaluate(async () => { const u = await window.claude.use("user"); return { id: await u.id(), canEdit: await u.canEdit(), owner: await u.isOwner() }; });
  ok("second user is non-admin", !sessB.canEdit && !sessB.owner, JSON.stringify(sessB));

  // --- Live update: write on A (instance 3101), observe on B (instance 3102) via SSE + LISTEN/NOTIFY
  await pB.evaluate(async () => {
    const db = await window.claude.use("db");
    window.__seen = [];
    window.__unsub = db.collection("encounters").onSnapshot((s) => window.__seen.push(s.docs.map((d) => d.id + ":" + (d.data().status || ""))));
    window.__docSeen = [];
    db.doc("settings/practice").onSnapshot((s) => window.__docSeen.push(s.exists ? s.data().practiceName : null));
  });
  await pB.waitForFunction(() => window.__seen.length >= 1);
  const t0 = Date.now();
  const newId = await pA.evaluate(async () => {
    const db = await window.claude.use("db");
    const ref = await db.collection("encounters").add({ status: "intake", patient: { name: "Test Patient" }, visit: {}, log: [] });
    return ref.id;
  });
  await pB.waitForFunction((id) => window.__seen.some((l) => l.includes(id + ":intake")), newId, { timeout: 5000 }).catch(() => {});
  let seen = await pB.evaluate(() => window.__seen.at(-1));
  ok("collection add on A appears live on B (cross-instance)", seen && seen.includes(newId + ":intake"), `${Date.now() - t0} ms`);

  await pA.evaluate(async (id) => { const db = await window.claude.use("db"); await db.doc("encounters/" + id).update({ status: "coded" }); }, newId);
  await pB.waitForFunction((id) => window.__seen.at(-1).includes(id + ":coded"), newId, { timeout: 5000 }).catch(() => {});
  seen = await pB.evaluate(() => window.__seen.at(-1));
  ok("doc update on A appears live on B", seen && seen.includes(newId + ":coded"));

  // The app's own state on page B picked it up too (its onSnapshot -> S.encounters)
  const appSaw = await pB.evaluate((id) => (typeof S !== "undefined" && S.encounters || []).some((e) => e.id === id), newId);
  ok("app UI state (S.encounters) on B updated live", appSaw);

  await pA.evaluate(async () => { const db = await window.claude.use("db"); await db.doc("settings/practice").set({ practiceName: "Test Clinic" }); });
  await pB.waitForFunction(() => window.__docSeen.includes("Test Clinic"), null, { timeout: 5000 }).catch(() => {});
  ok("admin writes settings/practice; doc snapshot on B updates", await pB.evaluate(() => window.__docSeen.includes("Test Clinic")));

  await pA.evaluate(async (id) => { const db = await window.claude.use("db"); await db.doc("encounters/" + id).delete(); }, newId);
  await pB.waitForFunction((id) => !window.__seen.at(-1).some((x) => x.startsWith(id)), newId, { timeout: 5000 }).catch(() => {});
  ok("delete on A disappears on B", await pB.evaluate((id) => !window.__seen.at(-1).some((x) => x.startsWith(id)), newId));

  // --- update() on a missing doc rejects (the page falls back to set)
  const upd = await pA.evaluate(async () => { const db = await window.claude.use("db"); try { await db.doc("encounters/nope").update({ a: 1 }); return "resolved"; } catch (e) { return e.code; } });
  ok("update() of missing doc rejects with not-found", upd === "not-found", upd);

  // --- __delete__ sentinel
  const del = await pA.evaluate(async () => {
    const db = await window.claude.use("db");
    await db.doc("settings/codesets").set({ a: 1, b: 2 });
    await db.doc("settings/codesets").update({ a: { __delete__: true }, c: 3 });
    return (await db.doc("settings/codesets").get()).data();
  });
  ok("update() with {__delete__:true} removes field", JSON.stringify(del) === '{"b":2,"c":3}', JSON.stringify(del));

  // --- Access rules (non-admin on B)
  const rules = await pB.evaluate(async (myId) => {
    const db = await window.claude.use("db");
    const t = async (f) => { try { await f(); return "ok"; } catch (e) { return e.code || e.message; } };
    return {
      settingsWrite: await t(() => db.doc("settings/practice").set({ practiceName: "Hacked" })),
      settingsRead: await t(() => db.doc("settings/practice").get()),
      rolesWrite: await t(() => db.doc("roles/x").set({ role: "admin" })),
      credsWrite: await t(() => db.doc("creds/jane").set({ role: "admin" })),
      membersList: await t(() => db.collection("members").get()),
      memberSelfWrite: await t(() => db.doc("members/" + myId).set({ name: "Nurse" })),
      memberSelfRead: await t(() => db.doc("members/" + myId).get()),
      memberOtherRead: await t(() => db.doc("members/u_someoneelse0000000000").get()),
      encounterWrite: await t(() => db.collection("encounters").add({ status: "intake" })),
      privateMine: await t(() => db.doc("data/users/" + myId + "/mfa_nurse").set({ secret: "x" })),
      privateMe: await t(() => db.doc("data/users/me/mfa").get()),
      privateOther: await t(() => db.doc("data/users/u_someoneelse0000000000/mfa").get()),
      unknownTop: await t(() => db.doc("secrets/x").get()),
      search: await t(async () => (await window.claude.use("user")).search("o")),
    };
  }, sessB.id);
  ok("non-admin write settings/practice denied", rules.settingsWrite === "permission-denied", rules.settingsWrite);
  ok("non-admin read settings allowed", rules.settingsRead === "ok");
  ok("non-admin write roles/creds denied", rules.rolesWrite === "permission-denied" && rules.credsWrite === "permission-denied");
  ok("non-admin list members denied", rules.membersList === "permission-denied");
  ok("own members doc read/write allowed", rules.memberSelfWrite === "ok" && rules.memberSelfRead === "ok");
  ok("other member doc read denied", rules.memberOtherRead === "permission-denied");
  ok("encounters write allowed (interact)", rules.encounterWrite === "ok");
  ok("data/users/{self} and data/users/me allowed", rules.privateMine === "ok" && rules.privateMe === "ok");
  ok("data/users/{other} denied", rules.privateOther === "permission-denied");
  ok("unknown collection denied", rules.unknownTop === "permission-denied");
  ok("user.search denied for non-admin", rules.search === "permission-denied");
  const settingsNow = await pool.query("SELECT data FROM documents WHERE path='settings/practice'");
  ok("settings/practice unchanged after denied write", settingsNow.rows[0].data.practiceName === "Test Clinic");

  // Owner can read members (as admin) and search users
  const own = await pA.evaluate(async () => {
    const db = await window.claude.use("db"); const u = await window.claude.use("user");
    const m = await db.collection("members").get();
    const s = await u.search("nurse");
    const ids = s.map((x) => x.id);
    const pr = await u.profiles(ids);
    return { members: m.size, search: s.map((x) => x.email), prof: Object.values(pr).map((p) => p.name) };
  });
  ok("admin: members list, user.search, user.profiles", own.members >= 1 && own.search.includes("nurse@example.com") && own.prof.includes("nurse"), JSON.stringify(own));

  // --- CSRF
  const csrf = await pA.evaluate(async () => (await fetch("/api/db/doc", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "set", path: "encounters/x", data: {} }) })).status);
  ok("POST without CSRF token is refused (403)", csrf === 403);

  // --- AI on B: no key configured -> proper error code
  const noKey = await pB.evaluate(async () => {
    const s = await window.claude.use("sample");
    const out = {};
    try { await s.json("Return exactly: {}"); } catch (e) { out.json = e.code; out.msg = e.message; }
    try { await s("hi", { onText: () => {} }); } catch (e) { out.stream = e.code; }
    out.raw = (await fetch("/api/ai", { method: "POST" })).status;
    return out;
  });
  ok("/api/ai without API key -> ai_not_configured", noKey.json === "ai_not_configured" && noKey.stream === "ai_not_configured", JSON.stringify(noKey));

  // --- AI on A: mock provider (TEST ONLY)
  const ai = await pA.evaluate(async () => {
    const s = await window.claude.use("sample");
    const out = {};
    out.json = await s.json("Summarize. Return exactly: {\"mock\":true}", { modelTier: "quick" });
    const chunks = [];
    const r = await s("Write a letter", { modelTier: "default", effort: "low", cache: false, onText: (u) => chunks.push(u.text) });
    out.streamChunks = chunks.length; out.streamFinal = r.text; out.progressive = chunks.length > 1 && chunks.every((c, i) => !i || c.startsWith(chunks[i - 1]));
    out.plain = (await s("plain")).text;
    const c = document.createElement("canvas"); c.width = 20; c.height = 20;
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg"));
    out.img = (await s.json("Read this. Return exactly: {}", { images: [blob, blob] })).images;
    out.limits = await s.limits();
    try { await s("__MOCK_429__"); } catch (e) { out.rate = e.code; }
    try { await s.json("__MOCK_LONG__"); } catch (e) { out.long = e.code; }
    const ctl = new AbortController();
    const p = s("Write a long letter", { signal: ctl.signal, onText: () => {} });
    setTimeout(() => ctl.abort(), 60);
    try { await p; out.abort = "resolved"; } catch (e) { out.abort = e.name + "/" + e.code; }
    return out;
  });
  ok("sample.json extracts JSON from fenced reply", ai.json && ai.json.mock === true && ai.json.note === 'canned {braces} "quoted"', JSON.stringify(ai.json));
  ok("sample() streams progressively via onText", ai.progressive && ai.streamFinal.startsWith("Mock reply"), `${ai.streamChunks} chunks`);
  ok("sample() non-streaming returns {text}", /Mock reply/.test(ai.plain));
  ok("sample images sent as image blocks", ai.img === 2, String(ai.img));
  ok("sample.limits()", ai.limits?.images?.maxCount === 5, JSON.stringify(ai.limits));
  ok("rate_limited / prompt_too_large codes", ai.rate === "rate_limited" && ai.long === "prompt_too_large", `${ai.rate} ${ai.long}`);
  ok("AbortSignal aborts the request", /AbortError\/aborted/.test(ai.abort), ai.abort);

  // --- downloads
  const [dl] = await Promise.all([
    pA.waitForEvent("download", { timeout: 5000 }),
    pA.evaluate(async () => { const d = await window.claude.use("downloads"); await d.save({ filename: "test.csv", data: "a,b\n1,2" }); }),
  ]);
  const dlPath = path.join(OUT, "dl-test.csv");
  await dl.saveAs(dlPath);
  ok("downloads.save triggers a browser download", dl.suggestedFilename() === "test.csv" && fs.readFileSync(dlPath, "utf8") === "a,b\n1,2");

  // --- Vendored libraries load and work under the CSP
  const libs = await pA.evaluate(async () => {
    const out = {};
    await loadScript(XLSX_URL); out.xlsx = !!window.XLSX;
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", 1]]), "S"); out.xlsxWrite = XLSX.write(wb, { type: "array", bookType: "xlsx" }).byteLength > 0;
    await loadScript(DOCX_URL); out.docx = !!window.docx;
    const doc = new docx.Document({ sections: [{ children: [new docx.Paragraph("hi")] }] }); out.docxBlob = (await docx.Packer.toBlob(doc)).size > 0;
    await loadScript(MAMMOTH); out.mammoth = !!window.mammoth;
    await loadScript(QR_URL); const q = window.qrcode(0, "M"); q.addData("otpauth://x"); q.make(); out.qr = q.createDataURL(5, 2).startsWith("data:image");
    const lib = await pdfLib(); out.pdf = !!lib.getDocument;
    const pdfBytes = new TextEncoder().encode("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    const pdf = await lib.getDocument({ data: pdfBytes, isEvalSupported: false, useSystemFonts: true }).promise;
    const tc = await (await pdf.getPage(1)).getTextContent(); out.pdfText = tc.items.map((i) => i.str).join("");
    return out;
  });
  ok("vendored xlsx/docx/mammoth/qrcode/pdf.js load and run under CSP", libs.xlsxWrite && libs.docxBlob && libs.mammoth && libs.qr && libs.pdfText === "Hello PDF", JSON.stringify(libs));

  // --- SSE reconnect: kill the stream server-side by restarting nothing; simulate by closing EventSource is internal,
  // so instead verify resync path: write directly in DB + NOTIFY a resync-like change.
  await pool.query("INSERT INTO documents(path, collection, doc_id, data, version) VALUES ('encounters/direct','encounters','direct','{\"status\":\"intake\"}', nextval('doc_version_seq'))");
  await pool.query("SELECT pg_notify('doc_changes', json_build_object('p','encounters/direct','v',currval('doc_version_seq'),'op','set')::text)");
  await pB.waitForFunction(() => window.__seen.at(-1).some((x) => x.startsWith("direct:")), null, { timeout: 5000 }).catch(() => {});
  ok("NOTIFY from any writer reaches subscribers", await pB.evaluate(() => window.__seen.at(-1).some((x) => x.startsWith("direct:"))));

  // --- SSE reconnect: restart instance B while page B is open; a write made while
  // it was down must show up after the shim reconnects and re-syncs.
  B.kill("SIGTERM");
  await new Promise((r) => B.on("exit", r));
  await pA.evaluate(async () => { const db = await window.claude.use("db"); await db.doc("encounters/while-down").set({ status: "billed" }); });
  B = startServer(3102, B_ENV);
  await waitHealthy(3102);
  await pB.waitForFunction(() => window.__seen.at(-1).some((x) => x === "while-down:billed"), null, { timeout: 20000 }).catch(() => {});
  ok("after server restart the stream reconnects and re-syncs missed writes", await pB.evaluate(() => window.__seen.at(-1).some((x) => x === "while-down:billed")));
  await pA.evaluate(async () => { const db = await window.claude.use("db"); await db.doc("encounters/after-up").set({ status: "paid" }); });
  await pB.waitForFunction(() => window.__seen.at(-1).some((x) => x === "after-up:paid"), null, { timeout: 5000 }).catch(() => {});
  ok("live updates continue after reconnect", await pB.evaluate(() => window.__seen.at(-1).some((x) => x === "after-up:paid")));

  // --- Screenshot of B after live update, CSP + console check
  await pB.waitForTimeout(500);
  await pB.screenshot({ path: path.join(OUT, "nurse-screen.png") });
  const cspA = await pA.evaluate(() => window.__csp);
  const cspB = await pB.evaluate(() => window.__csp);
  ok("no CSP violations", !cspA.length && !cspB.length, JSON.stringify([...cspA, ...cspB]));
  // Expected console noise: the 403/404 responses the access-rule tests provoke on purpose.
  const unexpected = [...msgsA, ...msgsB].filter((m) => !/status of (401|403|404|429|413|503)/.test(m) && !/Failed to load resource/.test(m));
  ok("no unexpected console errors", !unexpected.length, unexpected.join(" | "));
  fs.writeFileSync(path.join(OUT, "console.txt"), [...msgsA, ...msgsB].join("\n"));

  // --- Audit log captured activity without contents
  const aud = await pool.query("SELECT action, count(*)::int n FROM audit_log GROUP BY action ORDER BY action");
  const actions = Object.fromEntries(aud.rows.map((x) => [x.action, x.n]));
  ok("audit_log records login/create/update/delete/denied/ai", ["login", "create", "update", "delete", "denied", "ai"].every((a) => actions[a] > 0), JSON.stringify(actions));
  let immut = "allowed";
  try { await pool.query("DELETE FROM audit_log WHERE id < 0"); } catch { immut = "blocked"; }
  ok("audit_log is append-only", immut === "blocked");

  // --- No PHI in server logs
  const allLogs = A.logs.join("") + B.logs.join("");
  ok("server logs contain no prompt text or patient names", !/Test Patient|Write a letter|Summarize|Hacked/.test(allLogs));
  fs.writeFileSync(path.join(OUT, "server-logs.txt"), allLogs);

  // --- Idle timeout: age page B's session activity past the idle limit
  await pool.query("UPDATE session SET sess = jsonb_set(sess::jsonb, '{lastActivity}', '0')::json WHERE sess::jsonb->'user'->>'email' = 'nurse@example.com'");
  r = await pB.evaluate(async () => (await fetch("/api/session")).status);
  ok("idle session is rejected (401) and destroyed", r === 401);

  // --- Logout
  await pA.goto("http://localhost:3101/auth/logout");
  r = await pA.evaluate(async () => (await fetch("/api/session")).status);
  ok("logout ends the session", r === 401);
} catch (e) {
  console.error(e);
  ok("test run completed without exception", false, e.message);
} finally {
  await browser?.close();
  A.kill("SIGTERM"); B.kill("SIGTERM");
  await pool.end();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

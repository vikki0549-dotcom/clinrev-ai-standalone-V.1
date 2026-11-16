// OIDC sign-in test (development only) against a local oidc-provider instance.
//   DATABASE_URL=postgres://... node test/oidc-e2e.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Provider from "oidc-provider";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.DATABASE_URL || "postgres://clinrev:clinrev@127.0.0.1:5432/clinrev";
const results = [];
const ok = (name, cond, info = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  - " + info : ""}`); };

const ACCOUNTS = {
  alice: { email: "alice@allowed.test", name: "Alice Allowed", groups: [] },          // allowed by domain
  bob: { email: "bob@other.test", name: "Bob Blocked", groups: ["someone-else"] },     // not allowed
  carol: { email: "carol@other.test", name: "Carol Group", groups: ["clinrev-users"] }, // allowed by group
};
const provider = new Provider("http://localhost:3200", {
  clients: [{
    client_id: "clinrev", client_secret: "test-secret-not-real",
    redirect_uris: ["http://localhost:3103/auth/callback"],
    post_logout_redirect_uris: ["http://localhost:3103/auth/logged-out"],
  }],
  claims: { openid: ["sub"], email: ["email", "email_verified"], profile: ["name", "groups"] },
  conformIdTokenClaims: false,
  pkce: { required: () => true },
  features: { devInteractions: { enabled: true } },
  findAccount: (ctx, id) => ACCOUNTS[id] && { accountId: id, claims: () => ({ sub: id, email_verified: true, ...ACCOUNTS[id] }) },
});
const idp = provider.listen(3200);

const app = spawn(process.execPath, [path.join(ROOT, "server/index.js")], {
  env: {
    ...process.env, NODE_ENV: "development", PORT: "3103", DATABASE_URL: DB, AUTH_MODE: "oidc", OIDC_ALLOW_HTTP: "1",
    OIDC_ISSUER_URL: "http://localhost:3200", OIDC_CLIENT_ID: "clinrev", OIDC_CLIENT_SECRET: "test-secret-not-real",
    APP_BASE_URL: "http://localhost:3103", ALLOWED_EMAIL_DOMAINS: "allowed.test", OIDC_REQUIRED_GROUP: "clinrev-users",
    AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
app.stdout.on("data", (d) => (logs += d));
app.stderr.on("data", (d) => (logs += d));

let browser;
async function signIn(user) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3103/");
  await page.waitForSelector("input[name=login]", { timeout: 10000 });
  await page.fill("input[name=login]", user);
  await page.fill("input[name=password]", "any");
  await page.click("button[type=submit]");
  // consent screen (first time)
  await page.waitForLoadState("load");
  if (/localhost:3200/.test(page.url())) {
    const btn = await page.$("button[type=submit]");
    if (btn) { await btn.click(); await page.waitForLoadState("load"); }
  }
  await page.waitForTimeout(1500);
  return { ctx, page };
}

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://localhost:3103/healthz")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  browser = await chromium.launch();

  let r = await fetch("http://localhost:3103/", { redirect: "manual" });
  ok("anonymous request redirected to /auth/login", r.status === 302);
  r = await fetch("http://localhost:3103/auth/login", { redirect: "manual" });
  const loc = r.headers.get("location") || "";
  ok("/auth/login redirects to IdP with PKCE + state + nonce", loc.startsWith("http://localhost:3200/") && /code_challenge=/.test(loc) && /state=/.test(loc) && /nonce=/.test(loc));

  const a = await signIn("alice");
  const aText = await a.page.evaluate(() => document.body.innerText);
  ok("allowed-domain user reaches the app", a.page.url() === "http://localhost:3103/" && /ClinRev AI/.test(aText) && !/Loading workspace/.test(aText));
  const aSess = await a.page.evaluate(async () => (await fetch("/api/session")).json());
  ok("session user from ID token claims", aSess.user.email === "alice@allowed.test" && aSess.user.name === "Alice Allowed" && /^u_/.test(aSess.user.id), JSON.stringify(aSess.user));

  const b = await signIn("bob");
  const bText = await b.page.evaluate(() => document.body.innerText);
  ok("unauthorized user gets 403 page", /Access denied/.test(bText), bText.slice(0, 80));
  const bApi = await b.page.evaluate(async () => (await fetch("/api/session")).status);
  ok("unauthorized user has no API session", bApi === 401);

  const c = await signIn("carol");
  const cSess = await c.page.evaluate(async () => (await fetch("/api/session")).json().catch(() => null));
  ok("required-group user is authorized", cSess && cSess.user.email === "carol@other.test");

  await a.page.goto("http://localhost:3103/auth/logout");
  await a.page.waitForTimeout(500);
  // oidc-provider asks to confirm the RP-initiated logout
  const yes = await a.page.$("button[autofocus], button[type=submit]");
  if (yes && /localhost:3200/.test(a.page.url())) { await yes.click(); await a.page.waitForTimeout(800); }
  ok("logout goes through IdP end-session and lands on signed-out page", /\/auth\/logged-out/.test(a.page.url()), a.page.url());
  const after = await a.page.evaluate(async () => (await fetch("/api/session")).status);
  ok("session gone after logout", after === 401);
  ok("server logs hold no tokens", !/eyJ[A-Za-z0-9_-]{20,}/.test(logs));
} catch (e) {
  console.error(e);
  ok("oidc test completed", false, e.message);
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  idp.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
  setTimeout(() => process.exit(), 500);
}

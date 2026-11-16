// Authentication (OpenID Connect, or a dev-only fixed user), authorization
// allowlists, session timeouts and CSRF protection.
import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import * as oidc from "openid-client";
import { config, isProd } from "./config.js";
import { pool, upsertUser, audit } from "./db.js";
import { log, errInfo } from "./log.js";
import { page } from "./pages.js";

/* ---------------- identity helpers ---------------- */
export const userIdFor = (issuer, sub) =>
  "u_" + crypto.createHash("sha256").update(`${issuer}|${sub}`).digest("base64url").slice(0, 22);

const lc = (s) => String(s || "").trim().toLowerCase();

export function levelFor(email) {
  const e = lc(email);
  // Dev convenience: with no owners/admins configured, the default dev user is the owner.
  const devOwner = config.authMode === "dev" && !config.ownerEmails.length && !config.adminEmails.length && e === lc(config.dev.email);
  const isOwner = devOwner || (!!e && config.ownerEmails.includes(e));
  const isAdmin = isOwner || (!!e && config.adminEmails.includes(e));
  return { level: isAdmin ? "admin" : "interact", isOwner };
}

// Returns null when authorized, or a reason string.
export function authorizationProblem({ email, emailVerified, groups }) {
  const e = lc(email);
  if (!e) return "Your identity provider did not share an email address.";
  if (config.oidc.requireVerifiedEmail && emailVerified === false) return "Your email address is not verified.";
  if (config.ownerEmails.includes(e) || config.adminEmails.includes(e)) return null;
  const anyRule = config.allowedEmails.length || config.allowedDomains.length || config.oidc.requiredGroup;
  if (!anyRule) return config.authMode === "dev" ? null : "No users are authorized on this server.";
  if (config.allowedEmails.includes(e)) return null;
  const domain = e.split("@")[1] || "";
  if (config.allowedDomains.includes(domain)) return null;
  if (config.oidc.requiredGroup && Array.isArray(groups) && groups.map(String).includes(config.oidc.requiredGroup)) return null;
  return "Your account is not authorized to use this workspace.";
}

/* ---------------- session ---------------- */
const PgStore = connectPgSimple(session);
const secureCookie = config.baseUrl.startsWith("https://");
export const COOKIE_NAME = secureCookie ? "__Host-clinrev" : "clinrev.sid";
const IDLE_MS = config.idleTimeoutMin * 60_000;
const ABS_MS = config.absoluteTimeoutHours * 3_600_000;

export const sessionMiddleware = session({
  name: COOKIE_NAME,
  store: new PgStore({ pool, tableName: "session", createTableIfMissing: false, pruneSessionInterval: 15 * 60 }),
  secret: config.sessionSecret.split(","), // comma list allows secret rotation
  resave: false,
  saveUninitialized: false,
  rolling: false,
  proxy: true,
  cookie: { httpOnly: true, secure: secureCookie, sameSite: "lax", path: "/", maxAge: ABS_MS },
});

// Expires idle/old sessions and records activity. Requests that are not user
// activity (the event stream, automatic re-sync reads, marked by the shim with
// X-Activity: passive) do not extend the idle timer.
export function sessionTimeouts(req, res, next) {
  const s = req.session;
  if (!s?.user) return next();
  const now = Date.now();
  if (now - (s.lastActivity || 0) > IDLE_MS || now - (s.createdAt || 0) > ABS_MS) {
    const u = s.user;
    return s.destroy(() => {
      audit(u, "session-expired", null, req);
      res.clearCookie(COOKIE_NAME, { path: "/" });
      req.session = null;
      next();
    });
  }
  const passive = req.path === "/api/events" || req.get("x-activity") === "passive";
  if (!passive && now - (s.lastActivity || 0) > 30_000) s.lastActivity = now;
  next();
}

// Re-evaluates authorization and level on each request so allowlist/admin
// changes take effect on the next restart without waiting for re-login.
export function currentUser(req) {
  const u = req.session?.user;
  if (!u) return null;
  if (authorizationProblem(u)) return null;
  return { ...u, ...levelFor(u.email) };
}

export function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (u) { req.user = u; return next(); }
  if (req.session?.user) {
    // Signed in but no longer authorized.
    if (req.path.startsWith("/api/")) return res.status(403).json({ code: "permission-denied", message: "Not authorized" });
    return res.status(403).type("html").send(page("Access denied", "Your account is not authorized to use this workspace.", true));
  }
  if (req.path.startsWith("/api/") || req.method !== "GET") return res.status(401).json({ code: "unauthenticated", message: "Sign in again." });
  const rt = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(302, "/auth/login?returnTo=" + rt);
}

/* ---------------- CSRF ---------------- */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const expectedOrigin = new URL(config.baseUrl).origin;
export function csrf(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin && origin !== expectedOrigin && !(config.authMode === "dev" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))
    return res.status(403).json({ code: "csrf", message: "Cross-origin request refused" });
  const want = req.session?.csrf;
  const got = req.get("x-csrf-token") || "";
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)))
    return res.status(403).json({ code: "csrf", message: "Security token missing or expired. Reload the page." });
  next();
}

/* ---------------- login / logout routes ---------------- */
const safeReturn = (r) => (typeof r === "string" && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") && !r.startsWith("/auth/") ? r : "/");

async function establish(req, res, claims, returnTo, idToken) {
  const problem = authorizationProblem(claims);
  if (problem) {
    audit({ email: claims.email }, "login-denied", null, req);
    log.warn("login denied", { reason: "not-authorized" });
    return res.status(403).type("html").send(page("Access denied", problem, true));
  }
  const user = {
    id: userIdFor(claims.issuer, claims.sub),
    issuer: claims.issuer,
    sub: claims.sub,
    email: lc(claims.email),
    name: claims.name || claims.email,
    groups: Array.isArray(claims.groups) ? claims.groups.slice(0, 100).map(String) : [],
  };
  await upsertUser(user);
  req.session.regenerate((err) => {
    if (err) return res.status(500).type("html").send(page("Sign-in failed", "Please try again."));
    req.session.user = user;
    req.session.idToken = idToken || null;
    req.session.createdAt = req.session.lastActivity = Date.now();
    req.session.csrf = crypto.randomBytes(32).toString("base64url");
    req.session.save(() => {
      audit(user, "login", null, req);
      res.redirect(302, safeReturn(returnTo));
    });
  });
}

let oidcConfig = null;
async function getOidc() {
  if (oidcConfig) return oidcConfig;
  const auth = config.oidc.clientSecret ? undefined : oidc.None();
  // OIDC_ALLOW_HTTP: local testing against an http:// issuer only; ignored in production.
  const opts = !isProd && /^(1|true)$/i.test(process.env.OIDC_ALLOW_HTTP || "") ? { execute: [oidc.allowInsecureRequests] } : undefined;
  oidcConfig = await oidc.discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret || undefined, auth, opts);
  return oidcConfig;
}
const redirectUri = () => config.baseUrl + "/auth/callback";

export function authRouter() {
  const r = express.Router();

  r.get("/auth/login", async (req, res) => {
    const returnTo = safeReturn(req.query.returnTo);
    if (config.authMode === "dev") {
      // DEV ONLY (refused when NODE_ENV=production): sign in as DEV_USER_EMAIL,
      // or as ?as=<email> to test multiple users.
      const email = lc(req.query.as || config.dev.email);
      return establish(req, res, {
        issuer: "dev",
        sub: req.query.as ? email : config.dev.sub,
        email,
        name: req.query.as ? email.split("@")[0] : config.dev.name,
        groups: [],
      }, returnTo);
    }
    try {
      const cfg = await getOidc();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      req.session.oidc = { verifier, state, nonce, returnTo, at: Date.now() };
      const url = oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri(),
        scope: config.oidc.scopes,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      req.session.save(() => res.redirect(302, url.href));
    } catch (e) {
      log.error("oidc login failed", errInfo(e));
      res.status(502).type("html").send(page("Sign-in unavailable", "The identity provider could not be reached. Try again shortly."));
    }
  });

  r.get("/auth/callback", async (req, res) => {
    if (config.authMode === "dev") return res.redirect("/");
    const st = req.session?.oidc;
    if (!st || Date.now() - st.at > 10 * 60_000) return res.redirect(302, "/auth/login");
    try {
      const cfg = await getOidc();
      const current = new URL(config.baseUrl + req.originalUrl);
      const tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: st.verifier,
        expectedState: st.state,
        expectedNonce: st.nonce,
        idTokenExpected: true,
      });
      delete req.session.oidc;
      let c = tokens.claims() || {};
      if (!c.email && tokens.access_token) {
        try { c = { ...(await oidc.fetchUserInfo(cfg, tokens.access_token, c.sub)), ...c }; } catch {}
      }
      const email = c.email || c.preferred_username || c.upn || "";
      const groups = c[config.oidc.groupsClaim] ?? c["cognito:groups"] ?? c.groups ?? [];
      await establish(req, res, {
        issuer: c.iss,
        sub: c.sub,
        email: /@/.test(email) ? email : "",
        emailVerified: c.email_verified,
        name: c.name || [c.given_name, c.family_name].filter(Boolean).join(" ") || email,
        groups: Array.isArray(groups) ? groups : String(groups).split(/[ ,]+/),
      }, st.returnTo, tokens.id_token);
    } catch (e) {
      log.warn("oidc callback failed", errInfo(e));
      res.status(400).type("html").send(page("Sign-in failed", "The sign-in could not be completed. Close this tab and try again.", false, "/auth/login"));
    }
  });

  const logout = async (req, res) => {
    const u = req.session?.user;
    const idToken = req.session?.idToken;
    if (u) audit(u, "logout", null, req);
    const done = async () => {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      if (config.authMode === "oidc" && config.oidc.endSessionRedirect) {
        try {
          const cfg = await getOidc();
          if (cfg.serverMetadata().end_session_endpoint) {
            const url = oidc.buildEndSessionUrl(cfg, {
              post_logout_redirect_uri: config.baseUrl + "/auth/logged-out",
              ...(idToken ? { id_token_hint: idToken } : { client_id: config.oidc.clientId }),
            });
            return res.redirect(302, url.href);
          }
        } catch {}
      }
      res.redirect(302, "/auth/logged-out");
    };
    if (req.session) req.session.destroy(done);
    else done();
  };
  r.get("/auth/logout", logout);
  r.post("/auth/logout", logout);
  r.get("/auth/logged-out", (req, res) =>
    res.type("html").send(page("Signed out", "You have been signed out.", false, "/auth/login", "Sign in again")));
  return r;
}

export { isProd };

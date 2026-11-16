# ClinRev AI: standalone deployment

This project runs the ClinRev AI single-file web app **outside Claude's artifact
runtime**, on your own HTTPS domain, behind your organization's single sign-on.

The app itself is not rewritten. `public/index.html` is the file exported from
Claude with two mechanical edits (a `<script>` tag for the compatibility shim, and
self-hosted copies of its CDN libraries). Everything the page used to get from
Claude (`window.claude.use("db" | "user" | "sample" | "downloads")`) is now
provided by `public/runtime/claude-shim.js` and a Node.js + PostgreSQL backend.

---

## Architecture

```
            Browser (staff workstation)
   ┌──────────────────────────────────────────────────┐
   │ public/index.html   (the original app, unchanged)│
   │      │ window.claude.use(...)                    │
   │ public/runtime/claude-shim.js                    │
   │   db ─ fetch /api/db/*  + one EventSource /api/events
   │   user ─ /api/session, /api/users/*              │
   │   sample ─ /api/ai, /api/ai/stream (streamed)    │
   │   downloads ─ Blob + <a download> (local only)   │
   └───────────────┬──────────────────────────────────┘
                   │ HTTPS (TLS 1.2/1.3, HSTS)
           ┌───────▼────────┐   Let's Encrypt certificates (automatic)
           │  Caddy 2       │   (on AWS: ALB + ACM certificate)
           └───────┬────────┘
       round-robin │ HTTP, private network
     ┌─────────────┴─────────────┐
┌────▼──────────────┐   ┌────────▼──────────┐
│ app (Node 20)     │   │ app replica 2     │   Express: Helmet CSP (script hash),
│  OIDC login       │   │                   │   sessions in Postgres, CSRF,
│  access rules     │   │                   │   idle/absolute timeouts, audit log
│  SSE fan-out      │   │                   │
└──┬─────┬──────┬───┘   └──┬──────┬─────────┘
   │     │      │ LISTEN/NOTIFY  │
   │     │  ┌───▼────────────────▼──┐
   │     │  │ PostgreSQL 16         │  documents (JSONB), users, session,
   │     │  │ (internal network)    │  audit_log (append-only)
   │     │  └───────────────────────┘
   │     └──► Identity provider (OIDC): Cognito, Entra ID, Okta, Google, Auth0
   └────────► Claude: Anthropic API, or Amazon Bedrock
```

How live updates work: each page opens **one** `EventSource` (`/api/events`). On every
committed write, the server sends `NOTIFY doc_changes`. Every app instance LISTENs,
re-reads the changed row once and pushes it to each connected user who is allowed to
read it. The shim routes the change to the matching `onSnapshot` listeners. Each
document carries a monotonic version, so stale or duplicated events are ignored.
After a reconnect the shim re-fetches every live subscription. The server keeps no
per-subscription state, so there are no sticky sessions and any number of replicas works.

## Dependency analysis: what Claude provided, and what replaces it

| Claude runtime dependency | Used by the page for | Standalone replacement |
|---|---|---|
| `window.claude.use("db")`: Firestore-like store (`doc().get/set/update/delete/onSnapshot`, `collection().add/onSnapshot`) | encounters, settings, roles, creds, members, invites, per-user MFA secrets | `claude-shim.js` → `/api/db/*` → PostgreSQL `documents` table (path, collection, doc_id, `data jsonb`, version, updated_at, updated_by) |
| Real-time sync between users | live work queues, settings, roles | Server-Sent Events + Postgres `LISTEN/NOTIFY` fan-out across instances |
| Access rules declared by the artifact (view / interact / admin) | protecting settings, roles, creds, members, private MFA data | Enforced server-side in `server/rules.js` on every read, write and pushed change |
| Claude account identity: `user.me/id/isOwner/canEdit` | who is signed in, owner bootstrap, admin features | OpenID Connect sign-in (`openid-client`); id = `u_` + 22 chars of `base64url(sha256(issuer\|sub))`; admin/owner from `ADMIN_EMAILS` / `OWNER_EMAILS` |
| `user.profiles(ids)`, `user.search(q)` | names in "Users and roles", assigning roles | `users` table filled on each sign-in; `/api/users/profiles`, `/api/users/search` (admins only) |
| Claude account sign-in as the access gate | only signed-in people can open it | OIDC + `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS` / `OIDC_REQUIRED_GROUP`; everything (including `index.html` and `/vendor`) requires a session |
| `window.claude.use("sample")`: Claude calls (`sample.json`, `sample(prompt, {onText, images, signal, modelTier})`, `sample.limits()`) | clinical review, coding, prior auth, denial analysis, streamed appeal letters, reading scanned pages | `/api/ai` and `/api/ai/stream` → Anthropic Messages API (`@anthropic-ai/sdk`) or Amazon Bedrock (`@anthropic-ai/bedrock-sdk`); per-user rate limit; error codes `rate_limited`, `prompt_too_large`, `invalid_json`, `timeout` |
| `window.claude.use("downloads")` | claim files, CSV/XLSX/DOCX exports, appeal letters | Browser download via `Blob` + `<a download>` in the shim (no server involved) |
| Artifact CDN allowlist (cdnjs, jsdelivr) | pdf.js 3.11.174, docx 8.5.0, mammoth 1.6.0, qrcode-generator 1.4.4, xlsx 0.18.5 | Same versions from npm, copied to `public/vendor/` at build time (`tools/copy-vendor.js`), served same-origin behind auth |
| Claude's hosting, TLS and page sandbox | serving the page | Caddy (automatic HTTPS) or AWS ALB + ACM; strict CSP with a SHA-256 hash for the inline app script |
| Google Fonts (Inter, JetBrains Mono) | typography | Left as-is (optional; see "Self-hosting fonts") |

### Exactly what changed in the app file

`diff original/clinrev-ai.html public/index.html`:

```diff
260a261
> <script src="/runtime/claude-shim.js"></script>
1064c1065
< const QR_URL="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
> const QR_URL="/vendor/qrcode-generator-1.4.4/qrcode.js";
1220c1221
< const XLSX_URL="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",DOCX_URL="https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";
> const XLSX_URL="/vendor/xlsx-0.18.5/xlsx.full.min.js",DOCX_URL="/vendor/docx-8.5.0/index.umd.js";
1542,1543c1543,1544
< const PDFJS="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
< const MAMMOTH="https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js";
> const PDFJS="/vendor/pdfjs-3.11.174/";
> const MAMMOTH="/vendor/mammoth-1.6.0/mammoth.browser.min.js";
```

Every other byte is identical.

---

## Project layout

```
clinrev-standalone/
├── original/clinrev-ai.html     the file exported from Claude (input to make-index)
├── public/
│   ├── index.html               generated: original + shim tag + /vendor URLs
│   ├── runtime/claude-shim.js   window.claude.use(...) compatibility layer
│   └── vendor/                  generated: self-hosted browser libraries
├── server/
│   ├── index.js                 Express app, Helmet/CSP, static files, startup
│   ├── config.js                env parsing + validation (refuses unsafe prod config)
│   ├── auth.js                  OIDC login/logout, dev login, sessions, timeouts, CSRF
│   ├── api.js                   /api/session, /api/db/*, /api/events (SSE), /api/users/*
│   ├── rules.js                 server-side access rules
│   ├── db.js                    Postgres pool, migrations, documents, audit, LISTEN/NOTIFY
│   ├── ai/index.js              /api/ai, /api/ai/stream, rate limiting
│   ├── ai/providers.js          Anthropic API / Bedrock, error mapping
│   ├── ai/mock.js               TEST-ONLY canned AI (refused in production)
│   ├── pages.js                 sign-in error / signed-out pages
│   └── migrate-cli.js           npm run migrate
├── db/migrations/001_init.sql   schema (applied automatically at startup)
├── tools/
│   ├── make-index.js            rebuild public/index.html from a new Claude export
│   ├── copy-vendor.js           copy pinned library builds into public/vendor
│   └── import-artifact-export.js  import existing data
├── test/e2e.mjs, test/oidc-e2e.mjs   Playwright end-to-end tests (development only)
├── Dockerfile, .dockerignore, .env.example
└── deploy/
    ├── docker-compose.yml       Caddy + app (2 replicas) + Postgres (production)
    ├── docker-compose.dev.yml   app + Postgres with AUTH_MODE=dev (local only)
    ├── Caddyfile                automatic HTTPS, security headers, optional IP allowlist
    └── aws/README.md            ECS Fargate + RDS + ALB + ACM + Route 53 + Cognito + Bedrock
```

---

## Quick start (local, no identity provider)

Needs Docker with Compose v2.

```bash
docker compose -f deploy/docker-compose.dev.yml up --build
# open http://localhost:3000
```

You are signed in as `owner@example.com` (the workspace owner), and the app shows
its own "Create your administrator login" screen. AI steps need a key:
`ANTHROPIC_API_KEY=sk-ant-... docker compose -f deploy/docker-compose.dev.yml up --build`.
Without one, AI buttons show "AI is not configured on this server".

To try a second user, open a private window at
`http://localhost:3000/auth/login?as=coder@example.com`.

`AUTH_MODE=dev` signs in anyone who can reach the port. The server refuses to start
with it when `NODE_ENV=production`, and the dev compose file binds to 127.0.0.1 only.

Without Docker: Node 20+, a local PostgreSQL 16, then

```bash
npm ci && npm run vendor && npm run make-index
DATABASE_URL=postgres://clinrev:clinrev@localhost:5432/clinrev AUTH_MODE=dev npm start
```

---

## Production deployment (single server with Docker Compose)

Any Linux VM works (2 vCPU / 4 GB is plenty for a practice). For PHI, run it at a
provider that signs a **BAA** with you (AWS, Azure, Google Cloud and some others).
For a fully managed AWS setup, see [deploy/aws/README.md](deploy/aws/README.md).

1. **Server**: install Docker Engine + Compose plugin. Open inbound TCP 80 and 443 (and
   UDP 443 for HTTP/3). Keep SSH restricted to your IPs. Turn on automatic security updates
   and full-disk encryption (most clouds encrypt volumes by default; check).
2. **DNS**: create an `A` record (and `AAAA` if you use IPv6) `clinrev.example.com` →
   the server's public IP. Wait until `dig +short clinrev.example.com` returns it.
3. **Code**: copy this folder to the server (e.g. `/opt/clinrev`).
4. **Identity provider**: register an app (see below). Redirect URI:
   `https://clinrev.example.com/auth/callback`. Sign-out redirect:
   `https://clinrev.example.com/auth/logged-out`.
5. **Configure**: `cp .env.example .env`, then set at least:
   `APP_DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD` (`openssl rand -hex 32`),
   `SESSION_SECRET` (`openssl rand -base64 48`), `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, one of `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_EMAILS` /
   `OIDC_REQUIRED_GROUP`, `OWNER_EMAILS` (you), `ADMIN_EMAILS`, and the AI settings.
   `chmod 600 .env`.
6. **Start**:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   docker compose --env-file .env -f deploy/docker-compose.yml logs -f app caddy
   ```
   Caddy obtains the certificate on first request (watch for `certificate obtained successfully`).
7. **Verify HTTPS**:
   ```bash
   curl -sI https://clinrev.example.com/healthz   # HTTP/2 200
   curl -sI https://clinrev.example.com/          # 302 → /auth/login
   curl -sI http://clinrev.example.com/           # 308 → https://
   ```
   Then sign in with an owner account. You will see the app's "Create your
   administrator login" screen: set the in-app login and two-step verification as before.
   Optionally check the TLS grade at ssllabs.com.

Updating the server: `git pull` (or copy new files) then the same `up -d --build`.
Migrations run automatically.

### Registering the app with your identity provider

All providers: a **Web** application using the **authorization code** flow (PKCE is used
automatically), scopes `openid email profile`, redirect URI
`https://<domain>/auth/callback`, post-logout redirect `https://<domain>/auth/logged-out`.

| Provider | Issuer URL (`OIDC_ISSUER_URL`) | Notes |
|---|---|---|
| **Amazon Cognito** | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` | App client with a secret; "Authorization code grant"; add the callback and sign-out URLs; a Cognito domain is required. Groups: `OIDC_GROUPS_CLAIM=cognito:groups`. Set `OIDC_END_SESSION=false` (Cognito has no standard end-session endpoint). |
| **Microsoft Entra ID** | `https://login.microsoftonline.com/<tenant-id>/v2.0` | App registrations → New → Web redirect URI; Certificates & secrets → new client secret. Add the optional `email` claim to the ID token (Token configuration), or the app falls back to `preferred_username`. To restrict by group, add a groups claim and use the group's object ID in `OIDC_REQUIRED_GROUP`, or set "Assignment required" on the enterprise app. |
| **Okta** | `https://<org>.okta.com` or `https://<org>.okta.com/oauth2/default` | Applications → Create App Integration → OIDC → Web Application. Assign users/groups. For a groups claim add `groups` to the authorization server's ID token claims. |
| **Google Workspace** | `https://accounts.google.com` | Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web), consent screen "Internal". Restrict with `ALLOWED_EMAIL_DOMAINS=yourpractice.com`. |
| **Auth0** | `https://<tenant>.auth0.com/` | Regular Web Application; allowed callback + logout URLs as above. |

Who gets in: a user must sign in successfully **and** match `ALLOWED_EMAILS`,
`ALLOWED_EMAIL_DOMAINS` or `OIDC_REQUIRED_GROUP` (or be in `ADMIN_EMAILS`/`OWNER_EMAILS`).
Others see a 403 page. Levels inside the app: everyone authorized is *interact*;
`ADMIN_EMAILS` are *admin*; `OWNER_EMAILS` are *admin* + owner. The app's own roles,
in-app logins and two-step verification still apply on top of SSO.

---

## Backups

The only state is the PostgreSQL database (and Caddy's certificate volume, which can be re-issued).

Nightly logical backup (host crontab), encrypted, kept 30 days:

```cron
15 2 * * * cd /opt/clinrev && docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres pg_dump -U clinrev -d clinrev -Fc | gpg --batch --yes --encrypt -r backups@yourpractice.com > /var/backups/clinrev/clinrev-$(date +\%F).dump.gpg && find /var/backups/clinrev -name '*.dump.gpg' -mtime +30 -delete
```

Copy backups off the server (e.g. to an S3 bucket with versioning and Object Lock under
your BAA). Restore test:

```bash
gpg -d clinrev-2026-01-01.dump.gpg | docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres pg_restore -U clinrev -d clinrev --clean --if-exists
```

Note: `--clean` cannot drop `audit_log` rows because the table is append-only; restore
into an empty database instead when you need an exact copy.

---

## Updating the app from a new Claude export

When you change the app in Claude and export a new `clinrev-ai.html`:

```bash
cp ~/Downloads/clinrev-ai.html original/clinrev-ai.html
npm run make-index          # = node tools/make-index.js original/clinrev-ai.html
diff original/clinrev-ai.html public/index.html   # should show only the shim tag + /vendor URLs
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

The Docker build runs `make-index` itself, so copying the new file into `original/`
and rebuilding is enough. `make-index` **fails** if the new export loads a CDN script
it doesn't know (or a different library version). Add the library to
`tools/copy-vendor.js` (pinned in `package.json` devDependencies) and to `URL_MAP` in
`tools/make-index.js`. The CSP hash of the inline script is recomputed at every server
start, so no manual CSP change is needed. If a new version uses a new `window.claude`
capability or method, the shim must be extended.

## Migrating data from the Claude-hosted version

If you exported the artifact's data as JSON:

```bash
# { "<collectionPath>": { "<docId>": { ...data } } }   or a directory <collection>/<docId>.json
docker compose --env-file .env -f deploy/docker-compose.yml run --rm app node tools/import-artifact-export.js /path/in/container/export.json --dry-run
docker compose --env-file .env -f deploy/docker-compose.yml run --rm -v $PWD/export.json:/import.json:ro app node tools/import-artifact-export.js /import.json
```

The import is idempotent (upsert by path). What carries over and what doesn't:

- **encounters, settings, invites, creds** carry over unchanged. `creds/<login>`
  (login → role) keeps working.
- **members/\*, data/users/\*, roles/\*** are keyed by the *old Claude user ids*. New
  user ids come from your identity provider, so these documents don't match anyone.
  Each person signs in and **re-creates their in-app password and two-step verification**,
  and an administrator re-assigns roles in "Users and roles". Use `--skip-user-keyed` to
  leave `members` and `data/users` out of the import.

---

## Security and HIPAA notes

This is a technical foundation, not a compliance certification. Your HIPAA risk
analysis, policies, workforce training and BAAs remain your responsibility.

- **BAAs**: sign one with your hosting provider (AWS, Azure, GCP, etc.) and with the AI
  provider: either Anthropic (Anthropic API, BAA available for eligible customers;
  zero-data-retention terms as applicable) or AWS (Amazon Bedrock is HIPAA-eligible under
  the AWS BAA). Don't send PHI to the AI until that is in place. The app's banner
  "Use sample or de-identified records only…" is part of the original UI and stays.
- **Encryption in transit**: HTTPS only (Caddy/ALB), HSTS, `upgrade-insecure-requests`.
  The app ↔ Postgres link is on a private Docker network; use `DATABASE_SSL=verify-full`
  on RDS or any network you don't control.
- **Encryption at rest**: use encrypted disks/volumes (EBS/RDS with KMS, or LUKS on a VM)
  and encrypted backups.
- **Access control**: SSO (OIDC) with your IdP's MFA, an allowlist, server-side access
  rules for every read/write/push, and the app's own roles and TOTP on top.
- **Automatic logoff**: `SESSION_IDLE_TIMEOUT_MIN` (default 15) counts only real user
  input (keys, pointer, scroll); `SESSION_ABSOLUTE_TIMEOUT_HOURS` (default 12). Open
  live-update streams are closed when the session ends. Cookies: `__Host-` prefix,
  `Secure`, `HttpOnly`, `SameSite=Lax`.
- **Audit controls**: `audit_log` records sign-in/out, denied access, every document
  read/list/create/set/update/delete and every AI call (who, when, path, IP; never
  contents). A trigger makes it append-only. Live pushes to an open page are not logged
  one by one; the initial load of each collection/document is.
- **No PHI in logs**: the server logs JSON lines with status, timing and error classes
  only: no prompts, AI output, record contents, query strings, tokens or request
  bodies. Caddy access logging is off.
- **Browser hardening**: CSP `script-src 'self' 'sha256-…'` (no `unsafe-inline`, no
  `unsafe-eval`), `object-src 'none'`, `frame-ancestors 'none'`, `connect-src 'self'`;
  CSRF token header plus `Origin` check on every state-changing request.
- **Container**: non-root user, read-only root filesystem, all capabilities dropped,
  Postgres not published to the host network.
- **Known library advisories**: `xlsx@0.18.5` (prototype pollution / ReDoS when *parsing*
  untrusted spreadsheets; this app only *writes* XLSX) and `pdfjs-dist@3.11.174`
  (CVE-2024-4367, needs `isEvalSupported: true`; the app passes `false`, and the CSP
  blocks eval anyway). They are pinned because the app was built against them; plan to
  upgrade them in the Claude source.
- **Self-hosting fonts** (optional, avoids sending staff IPs to Google): download the
  Inter and JetBrains Mono woff2 files into `public/vendor/fonts/`, add a `@font-face`
  CSS file, point the `<link>` in `index.html` to it (add a `URL_MAP` entry in
  `tools/make-index.js`), and drop `fonts.googleapis.com`/`fonts.gstatic.com` from the CSP
  in `server/index.js`.

---

## Testing

Development only; needs Node 20+, PostgreSQL and Playwright with Chromium.

```bash
npm ci && npm run vendor && npm run make-index
DATABASE_URL=postgres://clinrev:clinrev@localhost:5432/clinrev_test node test/e2e.mjs        # wipes documents in that DB
DATABASE_URL=postgres://clinrev:clinrev@localhost:5432/clinrev_test node test/oidc-e2e.mjs   # local oidc-provider
```

`test/e2e.mjs` starts two app instances on one database and checks: sign-in redirects;
the app passing "Loading workspace…"; the in-app owner setup with TOTP enrollment;
cross-instance live updates; `update()` and `__delete__` semantics; every access rule;
CSRF; AI error codes with no key; streaming, images, JSON extraction and abort with the
**test-only** mock provider (`AI_PROVIDER=mock`, refused in production); downloads;
the vendored libraries running under the CSP; reconnect and re-sync after a server
restart; idle timeout; audit log; and no PHI in logs.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Caddy can't get a certificate | DNS A record points to this server; ports 80/443 reachable from the internet; `ACME_EMAIL` set; `docker compose logs caddy`. Use the staging CA line in the Caddyfile while testing. |
| Redirect loop or "Sign-in failed" | `APP_BASE_URL` exactly matches the public URL (https, no trailing slash) and the IdP redirect URI is `<APP_BASE_URL>/auth/callback`. Server clock in sync (NTP). |
| 403 "not authorized" after IdP sign-in | The user's email/domain/group isn't in `ALLOWED_*`/`OIDC_REQUIRED_GROUP`. For Entra, make sure an `email` claim is issued. For groups, check `OIDC_GROUPS_CLAIM`. |
| Page says "Open this page in claude.ai…" | The shim couldn't reach `/api/session`. Check the browser console/network tab and `docker compose logs app`. |
| Live updates stop / only refresh on reload | A proxy is buffering SSE. Caddy config here flushes immediately; on ALB set idle timeout ≥ 120 s; on nginx set `proxy_buffering off`. |
| "AI is not configured on this server" | `AI_PROVIDER` and `ANTHROPIC_API_KEY` (or Bedrock `AWS_REGION` + task role + model access). |
| "Too many AI requests" | Upstream 429, or the per-user limit (`AI_RATE_LIMIT_*`). |
| Logged out while reading | Idle timeout (`SESSION_IDLE_TIMEOUT_MIN`); any key/mouse activity keeps the session alive. |
| File import (PDF/DOCX) fails "A file reader could not load" | `public/vendor` is missing: run `npm run vendor` (the Docker build does this). |
| CSP errors in console after editing index.html by hand | Restart the server (the script hash is computed at startup). Use `tools/make-index.js` rather than manual edits. |
| Server exits "Invalid configuration" | The message lists each problem (missing OIDC settings, short `SESSION_SECRET`, dev mode in production, …). |

## Known differences from the Claude-hosted version

- **User ids** come from your IdP, so data keyed by old Claude ids (members, per-user
  MFA, role assignments) must be set up again after migration (see above).
- **Sign-out**: the original UI has no sign-out button (Claude handled that). Use
  `https://<domain>/auth/logout` (bookmark it), or let the idle timeout end the session.
  The app's own in-app "sign out" still works as before.
- `user.search` is limited to admins and to people who have signed in at least once;
  `user.profiles` returns names only for people who have signed in.
- `sample` options `effort` and `cache` are accepted and ignored. Rate limiting is per
  app instance.
- Writes are confirmed by the server before listeners fire (no offline queue). The writer
  sees its change as soon as the request returns; other users within milliseconds.

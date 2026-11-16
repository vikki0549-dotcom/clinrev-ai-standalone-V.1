// Reads and validates configuration from the environment. See .env.example.
const env = process.env;

const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (v, d) => (v == null || v === "" ? d : Number.parseInt(v, 10));
const bool = (v, d = false) => (v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

export const isProd = env.NODE_ENV === "production";

export const config = {
  isProd,
  port: int(env.PORT, 3000),
  baseUrl: (env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, ""),
  trustProxy: env.TRUST_PROXY || "1",
  databaseUrl: env.DATABASE_URL || "postgres://clinrev:clinrev@localhost:5432/clinrev",
  databaseSsl: env.DATABASE_SSL || "", // "", "require", "verify-full"
  databaseCaFile: env.DATABASE_CA_FILE || "",
  sessionSecret: env.SESSION_SECRET || "",
  idleTimeoutMin: int(env.SESSION_IDLE_TIMEOUT_MIN, 15),
  absoluteTimeoutHours: int(env.SESSION_ABSOLUTE_TIMEOUT_HOURS, 12),
  logLevel: env.LOG_LEVEL || "info",

  authMode: (env.AUTH_MODE || "oidc").toLowerCase(), // oidc | dev
  oidc: {
    issuer: env.OIDC_ISSUER_URL || "",
    clientId: env.OIDC_CLIENT_ID || "",
    clientSecret: env.OIDC_CLIENT_SECRET || "",
    scopes: env.OIDC_SCOPES || "openid email profile",
    groupsClaim: env.OIDC_GROUPS_CLAIM || "groups",
    requiredGroup: env.OIDC_REQUIRED_GROUP || "",
    requireVerifiedEmail: bool(env.OIDC_REQUIRE_VERIFIED_EMAIL, false),
    endSessionRedirect: bool(env.OIDC_END_SESSION, true),
  },
  allowedEmails: list(env.ALLOWED_EMAILS),
  allowedDomains: list(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, "")),
  adminEmails: list(env.ADMIN_EMAILS),
  ownerEmails: list(env.OWNER_EMAILS),
  dev: {
    email: env.DEV_USER_EMAIL || "dev@example.com",
    name: env.DEV_USER_NAME || "Dev User",
    sub: env.DEV_USER_SUB || env.DEV_USER_EMAIL || "dev-user",
  },

  ai: {
    provider: (env.AI_PROVIDER || "anthropic").toLowerCase(), // anthropic | bedrock (| mock: tests only)
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    modelDefault: env.CLAUDE_MODEL_DEFAULT || "claude-sonnet-4-5",
    modelQuick: env.CLAUDE_MODEL_QUICK || "claude-haiku-4-5",
    maxTokens: int(env.AI_MAX_TOKENS, 8000),
    timeoutMs: int(env.AI_TIMEOUT_MS, 120000),
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || "",
    rateCapacity: int(env.AI_RATE_LIMIT_BURST, 120),
    ratePerMinute: int(env.AI_RATE_LIMIT_PER_MIN, 60),
    maxImages: int(env.AI_MAX_IMAGES, 5),
    maxImageBytes: int(env.AI_MAX_IMAGE_BYTES, 3_750_000),
  },
};

export function validateConfig() {
  const errs = [];
  if (config.authMode === "dev") {
    if (isProd) errs.push("AUTH_MODE=dev is refused when NODE_ENV=production");
  } else if (config.authMode === "oidc") {
    for (const [k, v] of Object.entries({ OIDC_ISSUER_URL: config.oidc.issuer, OIDC_CLIENT_ID: config.oidc.clientId, APP_BASE_URL: process.env.APP_BASE_URL }))
      if (!v) errs.push(`${k} is required when AUTH_MODE=oidc`);
    if (!config.allowedEmails.length && !config.allowedDomains.length && !config.oidc.requiredGroup && !config.adminEmails.length && !config.ownerEmails.length)
      errs.push("Set at least one of ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, OIDC_REQUIRED_GROUP (otherwise nobody is authorized)");
  } else errs.push(`Unknown AUTH_MODE "${config.authMode}"`);

  if (isProd) {
    if (!config.sessionSecret || config.sessionSecret.length < 32) errs.push("SESSION_SECRET must be at least 32 characters in production");
    if (!config.baseUrl.startsWith("https://")) errs.push("APP_BASE_URL must be https:// in production");
    if (config.ai.provider === "mock") errs.push("AI_PROVIDER=mock is a test stub and is refused in production");
  } else if (!config.sessionSecret) {
    config.sessionSecret = "dev-only-insecure-session-secret-change-me-please";
  }
  if (!["anthropic", "bedrock", "mock"].includes(config.ai.provider)) errs.push(`Unknown AI_PROVIDER "${config.ai.provider}"`);
  if (errs.length) {
    const e = new Error("Invalid configuration:\n  - " + errs.join("\n  - "));
    e.code = "config";
    throw e;
  }
}

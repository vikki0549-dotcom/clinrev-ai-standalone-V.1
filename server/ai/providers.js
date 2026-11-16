// AI providers. Each provider exposes
//   complete({model, maxTokens, content, signal}) -> Promise<string>
//   stream({model, maxTokens, content, signal, onDelta}) -> Promise<string>
// where content is an Anthropic Messages API content-block array.
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";

export class AiError extends Error {
  constructor(code, message, status = 500) { super(message); this.code = code; this.status = status; }
}

// Maps SDK/upstream errors to the codes the page understands.
export function mapError(e, signal) {
  if (e instanceof AiError) return e;
  if (signal?.aborted) return new AiError("aborted", "Request cancelled.", 499);
  const status = e?.status;
  const name = e?.name || "";
  const msg = String(e?.error?.error?.message || e?.message || "");
  if (status === 429 || status === 529 || /ThrottlingException|ServiceQuotaExceeded/.test(name))
    return new AiError("rate_limited", "Too many AI requests. Wait a minute and try again.", 429);
  if (status === 413 || /prompt is too long|too many tokens|input is too long|exceeds.*(context|token)/i.test(msg))
    return new AiError("prompt_too_large", "The record is too long for one AI request.", 413);
  if (/Timeout/i.test(name) || e?.code === "ETIMEDOUT")
    return new AiError("timeout", "The AI took too long to answer. Try again.", 504);
  if (status === 401 || status === 403 || /AccessDenied|UnrecognizedClient|CredentialsProvider/i.test(name))
    return new AiError("ai_not_configured", "The AI service rejected this server's credentials. Ask your administrator to check the AI configuration.", 503);
  return new AiError("ai_error", "The AI service returned an error. Try again.", 502);
}

function anthropicLike(client) {
  const params = ({ model, maxTokens, content }) => ({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] });
  const textOf = (msg) => (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    async complete(o) {
      const msg = await client.messages.create(params(o), { signal: o.signal, timeout: config.ai.timeoutMs, maxRetries: 1 });
      return textOf(msg);
    },
    async stream(o) {
      const s = client.messages.stream(params(o), { signal: o.signal, timeout: config.ai.timeoutMs, maxRetries: 1 });
      s.on("text", (d) => o.onDelta(d));
      const msg = await s.finalMessage();
      return textOf(msg);
    },
  };
}

let cached = null;
export async function getProvider() {
  if (cached) return cached;
  const p = config.ai.provider;
  if (p === "anthropic") {
    if (!config.ai.anthropicApiKey) throw new AiError("ai_not_configured", "AI is not configured on this server (no API key). Ask your administrator.", 503);
    cached = anthropicLike(new Anthropic({ apiKey: config.ai.anthropicApiKey }));
  } else if (p === "bedrock") {
    if (!config.ai.awsRegion) throw new AiError("ai_not_configured", "AI is not configured on this server (no AWS region). Ask your administrator.", 503);
    // Credentials come from the default AWS chain (ECS task role, instance profile, env).
    cached = anthropicLike(new AnthropicBedrock({ awsRegion: config.ai.awsRegion }));
  } else if (p === "mock") {
    if (config.isProd) throw new AiError("ai_not_configured", "Mock AI is disabled in production.", 503);
    cached = (await import("./mock.js")).mockProvider; // TEST ONLY
  } else {
    throw new AiError("ai_not_configured", "Unknown AI provider.", 503);
  }
  return cached;
}

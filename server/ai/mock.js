// TEST-ONLY stub provider (AI_PROVIDER=mock). Refused when NODE_ENV=production.
// Returns canned text; never calls a network service.
//   prompt contains "__MOCK_429__"  -> rate_limited error
//   prompt contains "__MOCK_LONG__" -> prompt_too_large error
//   prompt contains "Return exactly" -> a fenced JSON object
//   otherwise                        -> a short multi-chunk text (streamed)
import { AiError } from "./providers.js";

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
});

function reply(content) {
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const images = content.filter((b) => b.type === "image").length;
  if (text.includes("__MOCK_429__")) throw new AiError("rate_limited", "Too many AI requests. Wait a minute and try again.", 429);
  if (text.includes("__MOCK_LONG__")) throw new AiError("prompt_too_large", "The record is too long for one AI request.", 413);
  if (/Return exactly/.test(text)) return 'Here you go:\n```json\n{"mock":true,"images":' + images + ',"note":"canned {braces} \\"quoted\\""}\n```';
  return `Mock reply line one.\nMock reply line two (${images} image${images === 1 ? "" : "s"}).\nMock reply line three.`;
}

export const mockProvider = {
  async complete({ content, signal }) {
    await sleep(50, signal);
    return reply(content);
  },
  async stream({ content, signal, onDelta }) {
    const full = reply(content);
    const parts = full.match(/[\s\S]{1,12}/g) || [];
    for (const p of parts) { await sleep(40, signal); onDelta(p); }
    return full;
  },
};

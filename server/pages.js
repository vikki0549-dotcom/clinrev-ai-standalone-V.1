// Tiny static pages for auth outcomes (no scripts; CSP-safe).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function page(title, message, offerSwitch = false, href = "", linkText = "Try again") {
  const links = [
    href ? `<a href="${esc(href)}">${esc(linkText)}</a>` : "",
    offerSwitch ? `<a href="/auth/logout">Sign in with a different account</a>` : "",
  ].filter(Boolean).join(" &middot; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ClinRev AI</title>
<style>body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f5f7;color:#1d2330;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #dde1e8;border-radius:10px;padding:28px 32px;max-width:440px;margin:16px}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:#4a5263}a{color:#2456c7}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#e8eaee}main{background:#1c2027;border-color:#2c323c}p{color:#aab1bf}a{color:#7aa2ff}}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${links ? `<p>${links}</p>` : ""}</main></body></html>`;
}

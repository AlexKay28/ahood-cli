const DEFAULT_API_URL = "https://ahood.vercel.app";

let warnedAboutOverride = false;

// AHOOD_API_URL is trusted with the bearer token on every request (see
// http.ts's apiFetch), so a scheme/host is validated rather than accepted
// verbatim -- an unvalidated override lets one stray env var (a malicious
// .envrc, CI config, or a script inside an installed skill) exfiltrate the
// token to an arbitrary host.
export function getApiUrl(): string {
  const configured = process.env.AHOOD_API_URL;
  if (!configured) return DEFAULT_API_URL;

  const trimmed = configured.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`AHOOD_API_URL is not a valid URL: "${configured}"`);
  }
  // Plain http:// is only allowed for localhost and the RFC 2606 reserved
  // test TLDs (.test/.invalid/.example/.localhost), which can never resolve
  // on the public internet -- everything else must be https:// so the
  // bearer token attached in http.ts is never sent in cleartext.
  const isLocalHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    /\.(test|invalid|example|localhost)$/i.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost)) {
    throw new Error(
      `AHOOD_API_URL must use https:// (http:// is only allowed for localhost/test hosts); got "${configured}".`,
    );
  }
  if (trimmed !== DEFAULT_API_URL && !warnedAboutOverride) {
    console.error(`warning: using non-default API endpoint from AHOOD_API_URL: ${trimmed}`);
    warnedAboutOverride = true;
  }
  return trimmed;
}

/**
 * Links whose target comes from outside the console (a certificate authority's terms page, a subscription's shop address,
 * an organization's work-product link, a release page) are only ever shown as http(s) addresses without credentials.
 * Anything else (javascript:, data:, file:, a malformed string) is not a link at all. The page's CSP already stops
 * inline script from running; this keeps such a value from being offered as something to click.
 */
export function httpUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

/** Schemes that are never a place to send a person back to, whatever the host says. */
const NEVER = new Set(["javascript", "data", "file", "blob", "about", "vbscript", "ws", "wss", "ftp", "ftps"].map((n) => `${n}:`));

/**
 * Where to send the person after they decide on an app's request. https, or http on this computer, as always; or an
 * app-specific address (cursor://, vscode://) that a Proxmox administrator allowed, in which case it must be the very
 * scheme and app the consent page showed (`expected`), never one of the schemes that run code or read local files.
 */
export function returnUrl(v: unknown, expected: string): string | null {
  const web = httpUrl(v);
  if (web) return web;
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return null;
  try {
    const u = new URL(v);
    const want = new URL(expected);
    if (NEVER.has(u.protocol) || u.protocol === "http:" || u.protocol === "https:" || u.username || u.password) return null;
    return u.protocol === want.protocol && u.host === want.host && want.protocol !== "http:" && want.protocol !== "https:" ? u.href : null;
  } catch {
    return null;
  }
}

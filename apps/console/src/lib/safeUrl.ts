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

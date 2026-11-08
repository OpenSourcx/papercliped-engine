/** An in-memory Cloudflare API (just the endpoints self-managed publishing uses). No network, no real token. */
export interface FakeRecord { id: string; type: string; name: string; content: string; proxied?: boolean }
export function fakeCloudflare() {
  const f = {
    tokenOk: true,
    missing: new Set<string>(),            // permission labels the token lacks
    accountList: true,                      // false: /accounts refused (no Account Settings: Read)
    zones: [{ id: "z1", name: "example.com", status: "active", account: { id: "a1", name: "Acme" } }] as { id: string; name: string; status: string; account: { id: string; name: string } }[],
    tunnels: [] as { id: string; name: string; config_src: string; deleted?: boolean }[],
    configs: new Map<string, unknown>(),
    records: [] as FakeRecord[],
    rateLimit: 0,                           // next N calls answer 429
    failOn: null as null | { match: RegExp; method?: string; status: number },
    calls: [] as string[],
    n: 0,
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  const ok = (result: unknown, info?: unknown) => json(200, { success: true, result, ...(info ? { result_info: info } : {}) });
  const refuse = (status: number, message: string, code = 10000) => json(status, { success: false, errors: [{ code, message }] });
  const needs = (label: string) => f.missing.has(label) ? refuse(403, "Authentication error") : null;
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/client/v4", ""), method = init.method ?? "GET";
    if (u.hostname !== "api.cloudflare.com") return json(404, {});
    f.calls.push(`${method} ${path}${u.search}`);
    const auth = (init.headers as Record<string, string>).Authorization;
    if (f.rateLimit > 0) { f.rateLimit--; return json(429, { success: false, errors: [{ message: "rate limited" }] }, { "retry-after": "1" }); }
    if (!f.tokenOk || auth !== "Bearer cf-fake-token-0123456789abcdef") return refuse(401, "Invalid API Token", 1000);
    if (f.failOn && f.failOn.match.test(`${method} ${path}`) && (!f.failOn.method || f.failOn.method === method)) return refuse(f.failOn.status, "injected failure");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/user/tokens/verify") return ok({ status: "active" });
    if (path === "/accounts") return f.accountList ? ok([{ id: "a1", name: "Acme" }]) : refuse(403, "Authentication error");
    if (path === "/zones" && method === "GET") {
      const denied = needs("Zone: Zone: Read"); if (denied) return denied;
      const per = Number(u.searchParams.get("per_page") ?? 20), page = Number(u.searchParams.get("page") ?? 1);
      const all = f.zones.filter((z) => z.status === "active");
      return ok(all.slice((page - 1) * per, page * per), { page, total_pages: Math.max(1, Math.ceil(all.length / per)) });
    }
    let m = path.match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (m) {
      const denied = needs("Zone: DNS: Edit"); if (denied) return denied;
      if (method === "GET") { const n = u.searchParams.get("name"); return ok(f.records.filter((r) => !n || r.name === n)); }
      if (method === "POST") { const r = { id: `r${++f.n}`, ...body }; f.records.push(r); return ok(r); }
      const i = f.records.findIndex((r) => r.id === m![2]);
      if (i < 0) return refuse(404, "Record does not exist", 81044);
      if (method === "DELETE") { f.records.splice(i, 1); return ok({ id: m[2] }); }
      if (method === "PUT") { f.records[i] = { id: m[2]!, ...body }; return ok(f.records[i]); }
    }
    m = path.match(/^\/accounts\/([^/]+)\/cfd_tunnel(?:\/([^/]+))?(?:\/(configurations|token|connections))?$/);
    if (m) {
      const denied = needs("Account: Cloudflare Tunnel: Edit"); if (denied) return denied;
      if (!m[2]) {
        if (method === "GET") { const n = u.searchParams.get("name"); return ok(f.tunnels.filter((t) => !t.deleted && (!n || t.name === n))); }
        if (method === "POST") { const t = { id: `t${++f.n}`, name: body.name, config_src: body.config_src }; f.tunnels.push(t); return ok(t); }
      }
      const t = f.tunnels.find((x) => x.id === m![2] && !x.deleted);
      if (!t) return refuse(404, "Tunnel not found", 1003);
      if (m[3] === "configurations" && method === "PUT") { f.configs.set(t.id, body); return ok(body); }
      if (m[3] === "token") return ok(`eyJ0dW5uZWwtdG9rZW4t${t.id}-0123456789`);
      if (m[3] === "connections" && method === "DELETE") return ok({});
      if (!m[3] && method === "DELETE") { t.deleted = true; return ok({ id: t.id }); }
    }
    return refuse(404, "no such route");
  };
  return { f, fetch };
}

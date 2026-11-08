// Tiny client (cookie jar + Origin) for the parity engines. Reused by every parity test.
export const NATIVE = process.env.PARITY_NATIVE ?? "http://127.0.0.1:3290";
export const EPC_ENGINE = process.env.PARITY_EPC_ENGINE ?? "http://127.0.0.1:3291";
export class Client {
  constructor(base, name = "u") { this.base = base; this.jar = ""; this.name = name; }
  async req(method, path, body, headers = {}) {
    const r = await fetch(this.base + path, { method, headers: { "Content-Type": "application/json", Origin: this.base, ...(this.jar ? { Cookie: this.jar } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) { const m = new Map(this.jar.split("; ").filter(Boolean).map((c) => c.split(/=(.*)/s))); for (const c of sc) { const [k, v] = c.split(";")[0].split(/=(.*)/s); m.set(k, v); } this.jar = [...m].map(([k, v]) => `${k}=${v}`).join("; "); }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  }
  signUp(email, password, name) { return this.req("POST", "/api/auth/sign-up/email", { email, password, name }); }
  signIn(email, password) { return this.req("POST", "/api/auth/sign-in/email", { email, password }); }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One driver per target, same `req(method, "/api/...")` surface. native = engine direct; epc = the host's /engine proxy as a signed-in Proxmox person. */
export async function driver(kind, opts = {}) {
  if (kind === "native") {
    const c = new Client(NATIVE);
    const email = opts.email ?? "admin@parity.invalid", pw = "Parity-pass-12345";
    let r = await c.signIn(email, pw);
    if (r.status !== 200) { r = await c.signUp(email, pw, opts.name ?? "Admin"); if (opts.claim) await c.req("POST", "/api/bootstrap/claim", {}); }
    return { kind, req: (m, p, b) => c.req(m, p, b), raw: c };
  }
  const { readFileSync } = await import("node:fs");
  const base = (process.env.PARITY_HOST ?? readFileSync("/project/.work/parity/epc/host.url", "utf8")).trim();
  const c = new Client(base);
  const r = await c.req("POST", "/api/login", { username: opts.user ?? "sam", password: "right", realm: "pve" }, { "X-EPC-Request": "1" });
  if (r.status !== 200) throw new Error("host login " + r.status);
  // The host opens the person's engine account in the background (sign-in never waits on the engine): wait for it.
  for (let i = 0; i < 40; i++) { const me = await c.req("GET", "/engine/api/cli-auth/me"); if (me.status === 200 && (opts.user ?? "sam") !== "sam" ? me.status === 200 : me.body?.isInstanceAdmin) break; await sleep(500); }
  return { kind, base, req: (m, p, b) => c.req(m, "/engine" + p, b, { "X-EPC-Request": "1" }), host: (m, p, b) => c.req(m, p, b, { "X-EPC-Request": "1" }), raw: c };
}

/** Result recorder: each check is {id, target, ok, detail, level}. Printed as JSON lines and saved by the runner. */
export function recorder() {
  const rows = [];
  return { rows, check(id, target, ok, detail = "", level = "real Paperclip runtime") { rows.push({ id, target, ok: !!ok, detail: String(detail).slice(0, 300), level }); console.log(`${ok ? "PASS" : "FAIL"} ${target.padEnd(6)} ${id} ${String(detail).slice(0, 160)}`); } };
}

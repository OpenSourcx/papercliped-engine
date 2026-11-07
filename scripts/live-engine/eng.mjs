// Tiny client for the disposable engine (cookie jar + Origin). Usage: import { E } from "./eng.mjs".
const BASE = "http://127.0.0.1:3199";
export class E {
  constructor(name = "u") { this.jar = ""; this.name = name; }
  async req(method, path, body, extra = {}) {
    const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, ...(this.jar ? { Cookie: this.jar } : {}), ...(extra.headers ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) this.jar = sc.map((c) => c.split(";")[0]).join("; ");
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  }
  async signUp(email, password, name) { const r = await this.req("POST", "/api/auth/sign-up/email", { email, password, name }); return r; }
  async signIn(email, password) { return this.req("POST", "/api/auth/sign-in/email", { email, password }); }
}

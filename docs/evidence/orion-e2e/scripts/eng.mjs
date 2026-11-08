const BASE = "http://127.0.0.1:3298"; let jar = "";
export async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, ...(jar ? { Cookie: jar } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie?.() ?? []; if (sc.length) jar = sc.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
await req("POST", "/api/auth/sign-in/email", { email: "admin@test.invalid", password: "Disposable-pass-12345" });

export const COMPANY = "6b151cd0-d1f0-4312-b958-f2fd9a398fe4";

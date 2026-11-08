const BASE = "http://127.0.0.1:3298";
let jar = "";
async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, ...(jar ? { Cookie: jar } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie?.() ?? []; if (sc.length) jar = sc.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
let r = await req("POST", "/api/auth/sign-up/email", { email: "admin@test.invalid", password: "Disposable-pass-12345", name: "Admin" }); console.log("signup", r.status);
r = await req("POST", "/api/bootstrap/claim", {}); console.log("claim", r.status);
r = await req("POST", "/api/companies", { name: "Orion Qualification Co" }); console.log("company", r.status, r.body.id);

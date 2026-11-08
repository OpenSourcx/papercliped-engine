import { E } from "./eng.mjs";
const a = new E();
let r = await a.signUp("admin@test.invalid", "Disposable-pass-12345", "Admin");
console.log("signup", r.status);
r = await a.req("POST", "/api/bootstrap/claim", {}); console.log("claim", r.status, JSON.stringify(r.body).slice(0, 200));
r = await a.req("GET", "/api/cli-auth/me"); console.log("me", r.status, JSON.stringify(r.body).slice(0, 300));
r = await a.req("POST", "/api/companies", { name: "Alpha Co" }); console.log("company", r.status, JSON.stringify(r.body).slice(0, 300));

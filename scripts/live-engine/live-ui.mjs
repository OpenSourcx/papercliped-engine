// LIVE UI check, step 2 (after live-ui-setup.mjs): keyboard/focus, grants round-trip, Pin enablement against the real engine, and 44px touch-target and overflow audits at 390px in both themes. HOST=<host address> EXE=<chrome-headless-shell> node live-ui.mjs
import { chromium } from "/project/aftercard/node_modules/playwright-core/index.mjs";
const BASE = process.env.HOST, EXE = process.env.EXE;
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const h = { "X-EPC-Request": "1", "Content-Type": "application/json" };
const out = { checks: [] }; const ok = (name, pass, detail = "") => { out.checks.push({ name, pass: !!pass, detail }); console.log(pass ? "PASS" : "FAIL", name, detail); };
async function open(vp, mobile, scheme) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, colorScheme: scheme });
  await ctx.addInitScript(() => localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assist", aiProvider: "claude", pinAccess: { read: true, act: false }, completedAt: "2026-11-07T00:00:00Z" })));
  const page = await ctx.newPage();
  const r = await page.request.post(BASE + "/api/login", { headers: h, data: { username: "sam", password: "right", realm: "pve" } });
  if (r.status() !== 200) throw new Error("login " + r.status());
  return { ctx, page };
}
const { ctx: c0, page: p0 } = await open({ width: 1440, height: 900 }, false, "dark");
const api = async (method, path, data) => { const x = await p0.request.fetch(BASE + "/engine" + path, { method, headers: h, data }); let j; try { j = await x.json(); } catch { j = await x.text(); } return { s: x.status(), j }; };
const cos = (await api("GET", "/api/companies")).j; const co = cos.find((c) => c.name === "Live UI Co"); const slug = co.issuePrefix.toLowerCase();
let agents = (await api("GET", `/api/companies/${co.id}/agents`)).j;
if (!agents.find((a) => a.name === "Helper")) await api("POST", `/api/companies/${co.id}/agents`, { name: "Helper", role: "general", adapterType: "http", adapterConfig: { url: "http://127.0.0.1:9/x" }, runtimeConfig: { heartbeat: { enabled: false } } });
const url = `${BASE}/pve/${slug}/connectors?section=apps`;

// 1. Desktop, live engine: connection row, grants editor reads/saves real engine data.
let page = p0; await page.goto(url, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
await page.screenshot({ path: "/project/.work/shots/live-org-apps-desktop-dark.png", fullPage: true });
ok("Organization apps page shows the live connection row", await page.getByText("Notes").first().isVisible());
ok("connection health is labelled (not colour alone)", await page.getByText(/healthy|Needs|Sign in again|unknown|error/i).first().isVisible().catch(() => false));
const trigger = page.getByRole("button", { name: "Agent access" }).first();
await trigger.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
const dlg = page.getByRole("dialog");
ok("dialog opens from the keyboard", await dlg.count() > 0);
const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
ok("focus moves into the dialog", await inDialog());
let escaped = false; for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); if (!(await inDialog())) { escaped = true; break; } }
ok("Tab stays inside the dialog (focus trap)", !escaped);
const ring = await page.evaluate(() => { const e = document.activeElement; const s = e ? getComputedStyle(e) : null; return s ? `${s.outlineStyle} ${s.outlineWidth} ${s.boxShadow !== "none"}` : ""; });
ok("focused control has a visible ring", /solid 2px|true/.test(ring), ring);
{ const sw = page.getByRole("switch", { name: "Helper" }); if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click(); }
await page.getByLabel("read_note").selectOption("allow").catch(() => {});
await page.getByLabel("write_note").selectOption("ask").catch(() => {});
await page.screenshot({ path: "/project/.work/shots/live-agent-access-desktop-dark.png" });
await page.getByRole("button", { name: "Save access" }).click(); await page.waitForTimeout(1500);
ok("Save closes the dialog", await page.getByRole("dialog").count() === 0);
await trigger.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(1200);
ok("reopened editor keeps the saved grants (read_note allow)", (await page.getByLabel("read_note").inputValue().catch(() => "")) === "allow");
ok("reopened editor keeps write_note ask", (await page.getByLabel("write_note").inputValue().catch(() => "")) === "ask");
ok("reopened editor keeps the agent selected", (await page.getByRole("switch", { name: "Helper" }).getAttribute("aria-checked").catch(() => "")) === "true");
await page.keyboard.press("Escape"); await page.waitForTimeout(500);
ok("Esc closes the dialog", await page.getByRole("dialog").count() === 0);
ok("focus returns to the control that opened it", await page.evaluate(() => document.activeElement?.textContent?.includes("Agent access")));

// 2. Pin card: enable, set access, against the real engine.
await page.getByRole("button", { name: "Let Pin use apps here" }).click().catch(() => {}); await page.waitForTimeout(2500);
ok("Pin enabled (identity created in the engine)", await page.getByRole("button", { name: "Set Pin access" }).count() > 0);
await page.getByRole("button", { name: "Set Pin access" }).click(); await page.waitForTimeout(1200);
await page.getByLabel("read_note").selectOption("allow"); await page.getByLabel("write_note").selectOption("ask");
await page.getByRole("button", { name: "Save", exact: true }).click(); await page.waitForTimeout(2000);
const pin = (await api("GET", `/api/companies/${co.id}/agents`)).j.find((a) => a.name === "Pin (host)");
ok("engine has a paused 'Pin (host)' identity", pin?.status === "paused", pin?.status);
const pol = (await api("GET", `/api/companies/${co.id}/tools/policies`)).j.policies.filter((p) => p.name.startsWith("Pin (host)"));
ok("engine holds default-deny plus allow and require_approval policies for Pin", pol.map((p) => p.policyType).sort().join() === "allow,block,require_approval", pol.map((p) => p.policyType).join());
await page.screenshot({ path: "/project/.work/shots/live-org-apps-pin-desktop-dark.png", fullPage: true });
await c0.close();

// 3. Mobile (touch): audit target sizes and horizontal overflow on live screens, both themes.
for (const scheme of ["dark", "light"]) {
  const { ctx, page: pm } = await open({ width: 390, height: 844 }, true, scheme);
  if (scheme === "light") await ctx.addInitScript(() => localStorage.setItem("epc.theme", JSON.stringify({ preset: "clip-light", mode: "fixed", accent: null, recentAccents: [], railAccent: true, radius: 0.625, transparency: true, glass: 55, glassBlur: 22, glassAlpha: 0.6, fontScale: 1 })));
  const pages = { "org-apps": url, "access-remote": `${BASE}/pve/home?settings=access&access=remote`, "access-people": `${BASE}/pve/home?settings=access`, "plugins": `${BASE}/pve/home?settings=community-plugins`, "org-apps-agent-dialog": url };
  for (const [name, u] of Object.entries(pages)) {
    await pm.goto(u, { waitUntil: "networkidle" }); await pm.waitForTimeout(1500);
    if (name === "org-apps-agent-dialog") { await pm.getByRole("button", { name: "Agent access" }).first().click(); await pm.waitForTimeout(1200); }
    const audit = await pm.evaluate(() => {
      const bad = []; const els = document.querySelectorAll('button, [role=button], [role=switch], [role=radio], [role=tab], select, input:not([type=hidden]), summary');
      for (const e of els) { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") continue; if (r.height < 43.5 || r.width < 43.5) bad.push(`${(e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`); }
      return { bad, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
    });
    ok(`mobile ${scheme} ${name}: every interactive control is at least 44px`, audit.bad.length === 0, audit.bad.slice(0, 6).join("; "));
    ok(`mobile ${scheme} ${name}: no horizontal overflow`, audit.sw <= audit.cw, `${audit.sw}/${audit.cw}`);
    await pm.screenshot({ path: `/project/.work/shots/live-${name}-mobile-${scheme}.png`, fullPage: false });
  }
  await ctx.close();
}
console.log(JSON.stringify({ pass: out.checks.filter((c) => c.pass).length, fail: out.checks.filter((c) => !c.pass).length }));
await browser.close();

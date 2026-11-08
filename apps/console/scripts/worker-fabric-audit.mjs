// Worker Fabric UI pass (Playwright, headless Chromium). SIMULATED: the built console is served by `vite preview` and the host
// API (/api/me, /api/host, /api/engine/status, /engine/api/*, /api/fabric/*) is stubbed in-page with the shapes of
// docs/WORKER-FABRIC.md section 4. For each view, in both palettes at 390px (touch) and 1280px, it checks horizontal overflow,
// control sizes, accessible names, heading order, duplicate ids, text contrast (WCAG AA) and keyboard focus, takes a screenshot
// and saves the accessibility tree. BASE=http://127.0.0.1:4199 EXE=<chrome-headless-shell> OUT=<dir> node worker-fabric-audit.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/project/aftercard/node_modules/playwright-core/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4199";
const OUT = process.env.OUT ?? "/project/.work/shots-worker-fabric";
mkdirSync(OUT, { recursive: true });
const NOW = Date.now();
const caps = (o = {}) => ({ os: { name: "Ubuntu", version: "22.04" }, arch: "arm64", hostname: "kpnai", cpu: { model: "Cortex-A78AE", cores: 6 }, memMb: 7620, gpu: { present: true, name: "Orin (nvgpu)", kind: "jetson" }, storage: [{ path: "/workspaces", totalGb: 229, freeGb: 150 }], tools: { git: "2.34.1", node: "22.11.0", pnpm: "10.28.0", python: "3.10.12" }, inference: { runtime: "ollama", url: "http://100.93.29.26:11434", models: [{ name: "qwen2.5-coder:3b" }, { name: "qwen2.5-coder:1.5b" }], maxContext: 4096 }, networks: [{ provider: "tailscale", address: "100.93.29.26" }], workspaceRoot: "/workspaces", ...o });
const W = (o = {}) => ({ id: "w1", name: "Orion", state: "adopted", online: true, draining: false, disabled: false, fingerprint: "SHA256:7f3a9c1be2d84a05", version: "0.1.0", lastSeen: NOW, connectedSince: NOW - 3600000, transport: { provider: "tailscale", address: "100.93.29.26" }, companies: null, shellSlots: 3, inferenceSlots: 1, usage: { shellLeases: 2, inferenceRunning: 1, inferenceQueued: 0, loadAvg: 1.5, freeMemMb: 3000 }, capabilities: caps(), ...o });
const transports = [
  { provider: "tailscale", label: "Tailscale", available: true, recommended: true, address: "100.64.0.1", detail: "Detected on this device. Workers on your tailnet can reach it." },
  { provider: "lan", label: "Local network", available: true, address: "192.168.1.10", detail: "Workers on the same private network can reach this address." },
  { provider: "custom", label: "Custom or existing network", available: false, detail: "Set EPC_FABRIC_PUBLIC_URL to use your own VPN, WireGuard or reverse proxy." },
];
const pending = [{ id: "p1", name: "jetson-bench", verification: "K7QX-M2PD", fingerprint: "SHA256:aa11bb22cc33dd44", requestedAt: NOW, expiresAt: NOW + 12 * 60000, capabilities: caps({ hostname: "jetson-bench" }), remote: "100.93.29.31" }];
const state = {};
function reset(kind) {
  state.kind = kind;
  state.workers = kind === "empty" ? [] : [W(), W({ id: "w2", name: "Workshop NUC", online: false, lastSeen: NOW - 7200000, transport: { provider: "lan", address: "192.168.1.44" }, usage: { shellLeases: 0, inferenceRunning: 0, inferenceQueued: 0, loadAvg: null, freeMemMb: null }, capabilities: caps({ arch: "x64", gpu: { present: false }, inference: null, os: { name: "Debian", version: "12" }, cpu: { model: "Intel N100", cores: 4 }, memMb: 16384 }) }), W({ id: "w3", name: "Old laptop", state: "revoked", online: false, lastSeen: NOW - 86400000 * 5 })];
  state.pending = kind === "full" ? pending : [];
  state.pairings = [];
  state.arrived = false;
}
const ov = () => ({ enabled: state.kind !== "off", hostKey: { fingerprint: "SHA256:host" }, listen: { url: "ws://100.64.0.1:3131", port: 3131 }, transports, workers: state.workers.concat(state.arrived ? [W({ id: "w9", name: "jetson-2" })] : []), pending: state.pending, pairings: state.pairings, environments: state.kind === "empty" ? [] : [{ id: "e1", companyId: "c1", name: "Orion GPU", workerId: "w1", requirements: { gpu: true, localModel: "qwen2.5-coder:3b" }, agents: ["a1"] }] });

async function stub(ctx) {
  await ctx.route(/\/(api|engine\/api)\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const j = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (p === "/api/me") return j({ user: { username: "sam@pve", name: "Sam", realm: "pve", node: "pve" } });
    if (p === "/api/host") return j({ node: "pve", version: "9.0", status: null, resources: [], storage: [] });
    if (p === "/api/engine/status") return j({ installed: true, reachable: true, ready: true, version: "2026.1023.0", bootstrap: "ready" });
    if (p.endsWith("/api/companies") && req.method() === "GET") return j([{ id: "c1", name: "Acme Robotics", issuePrefix: "ACM" }]);
    if (/\/api\/companies\/[^/]+\/agents$/.test(p)) return j([{ id: "a1", name: "Builder" }, { id: "a2", name: "Reviewer" }]);
    if (p === "/api/fabric/stream") return route.abort();
    if (p === "/api/fabric") return state.kind === "missing" ? j({ error: "Not found" }, 404) : j(ov());
    if (p === "/api/fabric/pairings" && req.method() === "POST") { state.pairings = [{ id: "pr1", name: "", createdAt: NOW, expiresAt: NOW + 15 * 60000 }]; return j({ id: "pr1", code: "epw1.eyJ1IjpbIndzOi8vMTAwLjY0LjAuMToz...kXs9v", expiresAt: state.expire ? NOW - 1000 : NOW + 15 * 60000, installCommand: "sudo epaperclip-worker adopt epw1.eyJ1IjpbIndzOi8vMTAwLjY0LjAuMToz...kXs9v" }, 201); }
    const m = p.match(/^\/api\/fabric\/workers\/([^/]+)$/);
    if (m && req.method() === "GET") { const w = state.workers.find((x) => x.id === m[1]); return w ? j({ worker: w, leases: [{ id: "l1", workerId: w.id, companyId: "c1", agentId: "agent-builder", runId: "run-4821", environmentId: "e1", workspace: "/workspaces/c1/agent-builder/run-4821", state: "active", createdAt: NOW - 120000 }, { id: "l2", workerId: w.id, companyId: "c1", agentId: "agent-reviewer", runId: "run-4790", environmentId: "e1", workspace: "/workspaces/c1/agent-reviewer/run-4790", state: "released", createdAt: NOW - 5400000, releasedAt: NOW - 5000000 }], audit: [{ n: 3, at: NOW - 60000, actor: "sam@pve", action: "worker.drain", workerId: w.id, detail: "draining on" }, { n: 2, at: NOW - 3600000, actor: "system", action: "worker.connected", workerId: w.id }, { n: 1, at: NOW - 86400000, actor: "sam@pve", action: "worker.adopted", workerId: w.id, detail: "via pairing code" }] }) : j({ error: "No such worker" }, 404); }
    if (m && req.method() === "PATCH") return j({});
    return j({ error: "Not found" }, 404);
  });
}

const FOCUS = () => {
  // Does the focused element show a visible indicator (outline or ring box-shadow)?
  const e = document.activeElement; if (!e || e === document.body) return null;
  const s = getComputedStyle(e);
  const ring = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 || (s.boxShadow && s.boxShadow !== "none");
  return { tag: e.tagName.toLowerCase(), label: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 30), ring: !!ring };
};

async function audit(page, mobile) {
  return page.evaluate(({ mobile }) => {
    const out = { overflowX: false, small: [], unnamed: [], dupIds: [], headingJumps: [], lowContrast: [] };
    const root = document.scrollingElement; out.overflowX = root.scrollWidth > innerWidth + 1;
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !e.closest("[aria-hidden=true]") && !e.closest("[inert]"); };
    const nameOf = (e) => { const lb = e.getAttribute("aria-labelledby"); if (lb) return lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim(); const al = e.getAttribute("aria-label"); if (al) return al.trim(); if (e.labels?.length) return [...e.labels].map((l) => l.textContent).join(" ").trim(); const t = (e.textContent || "").trim(); return t || (e.getAttribute("title") || "").trim(); };
    const min = mobile ? 44 : 40;
    for (const e of document.querySelectorAll('a[href], button, [role=button], [role=switch], [role=radio], [role=tab], select, input:not([type=hidden]), textarea, summary, [tabindex="0"]')) {
      if (!vis(e)) continue;
      if (!nameOf(e)) out.unnamed.push(e.outerHTML.slice(0, 80));
      if (e.tagName === "PRE") continue;
      const box = e.type === "checkbox" || e.type === "radio" ? (e.closest("label") ?? e) : e;
      const r = box.getBoundingClientRect();
      if (r.height < min - 0.5 || r.width < min - 0.5) { if (r.width < 4) continue; out.small.push(`${e.tagName.toLowerCase()} "${nameOf(e).slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`); }
    }
    const ids = {}; for (const e of document.querySelectorAll("[id]")) ids[e.id] = (ids[e.id] || 0) + 1; out.dupIds = Object.entries(ids).filter(([, n]) => n > 1).map(([i]) => i);
    let last = 0; for (const h of document.querySelectorAll("h1,h2,h3")) { if (!vis(h)) continue; const l = +h.tagName[1]; if (last && l > last + 1) out.headingJumps.push(`h${last}->h${l} ${h.textContent.trim().slice(0, 24)}`); last = l; }
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); if (c.startsWith("color(")) return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 }; return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bg = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) layers.push(c); if (c && c.a >= 1) break; } let base = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }; if (base.a < 1) base = { r: 255, g: 255, b: 255 }; for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; return base; };
    const seen = new Set();
    for (const e of document.querySelectorAll("p, span, div, label, button, a, h1, h2, h3, li, dt, dd, pre, legend")) {
      if (!vis(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(e); const fg = parse(cs.color); if (!fg) continue; const b = bg(e);
      const f = { r: fg.r * fg.a + b.r * (1 - fg.a), g: fg.g * fg.a + b.g * (1 - fg.a), b: fg.b * fg.a + b.b * (1 - fg.a) };
      const l1 = lum(f), l2 = lum(b); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700; const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (e.closest("[disabled], [aria-disabled=true]")) continue;
      if (ratio < need) { const k = e.textContent.trim().slice(0, 24) + ratio.toFixed(1); if (!seen.has(k)) { seen.add(k); out.lowContrast.push(`${ratio.toFixed(2)}<${need} "${e.textContent.trim().slice(0, 28)}"`); } }
    }
    return out;
  }, { mobile });
}

const browser = await chromium.launch({ executablePath: process.env.EXE, args: ["--no-sandbox"] });
const rows = [];
const scenes = [
  { id: "list-full", kind: "full", url: "/pve/datacenter/workers" },
  { id: "list-empty", kind: "empty", url: "/pve/datacenter/workers" },
  { id: "unavailable", kind: "missing", url: "/pve/datacenter/workers" },
  { id: "off", kind: "off", url: "/pve/datacenter/workers" },
  { id: "detail", kind: "full", url: "/pve/datacenter/workers/w1" },
  { id: "detail-leases", kind: "full", url: "/pve/datacenter/workers/w1", act: async (p) => { await p.getByRole("tab", { name: /Leases/ }).click(); } },
  { id: "detail-activity", kind: "full", url: "/pve/datacenter/workers/w1", act: async (p) => { await p.getByRole("tab", { name: /Activity/ }).click(); } },
  { id: "revoke-confirm", kind: "full", url: "/pve/datacenter/workers/w1", act: async (p) => { await p.getByRole("button", { name: "Revoke", exact: true }).click(); await p.getByRole("dialog").waitFor(); } },
  { id: "adopt-choose", kind: "full", url: "/pve/datacenter/workers?modal=adopt-worker", act: async (p) => { await p.getByRole("radiogroup").waitFor(); } },
  { id: "adopt-code", kind: "full", url: "/pve/datacenter/workers?modal=adopt-worker", act: async (p) => { const b = p.getByRole("button", { name: "Create pairing code" }); await b.waitFor(); await p.waitForFunction(() => !document.querySelector("button[aria-busy]") && ![...document.querySelectorAll("button")].find((x) => x.textContent === "Create pairing code")?.disabled); await b.click(); await p.getByText("Waiting for the worker to connect").waitFor(); } },
  { id: "adopt-expired", kind: "full", expire: true, url: "/pve/datacenter/workers?modal=adopt-worker", act: async (p) => { const b = p.getByRole("button", { name: "Create pairing code" }); await b.waitFor(); await p.waitForFunction(() => ![...document.querySelectorAll("button")].find((x) => x.textContent === "Create pairing code")?.disabled); await b.click(); await p.getByText("This code expired").waitFor(); } },
  { id: "use-worker", kind: "full", url: "/pve/datacenter/workers?modal=use-worker", act: async (p) => { await p.getByRole("button", { name: "Create environment" }).waitFor(); } },
];
for (const scheme of ["dark", "light"]) {
  for (const vp of [{ n: "390", width: 390, height: 844, mobile: true }, { n: "1280", width: 1280, height: 900, mobile: false }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, hasTouch: vp.mobile, isMobile: vp.mobile });
    await ctx.addInitScript((sch) => { localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assist", aiProvider: "claude", pinAccess: { read: true, act: false }, completedAt: "2026-11-07T00:00:00Z" })); if (sch === "light") localStorage.setItem("epc.theme", JSON.stringify({ preset: "clip-light", mode: "fixed", accent: null, recentAccents: [], railAccent: true, radius: 0.625, transparency: true, glass: 55, glassBlur: 22, glassAlpha: 0.6, fontScale: 1 })); }, scheme);
    await stub(ctx);
    for (const s of scenes) {
      reset(s.kind); state.expire = !!s.expire;
      const page = await ctx.newPage();
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(BASE + s.url, { waitUntil: "networkidle" });
      await page.waitForTimeout(700);
      if (s.act) await s.act(page);
      await page.waitForTimeout(500);
      const a = await audit(page, vp.mobile);
      // Keyboard: Tab through up to 40 stops; every stop needs a visible focus indicator; Esc closes a dialog.
      const stops = []; for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); const f = await page.evaluate(FOCUS); if (!f) continue; stops.push(f); }
      const noRing = stops.filter((f) => !f.ring).map((f) => `${f.tag} "${f.label}"`);
      let escape = null;
      if (await page.getByRole("dialog").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(500); escape = (await page.getByRole("dialog").count()) === 0 ? "closes" : "STAYS OPEN"; }
      const file = `${OUT}/${s.id}-${vp.n}-${scheme}.png`;
      await page.screenshot({ path: file, fullPage: false });
      // Accessibility tree (main + dialog) of the first palette/width only, as text.
      if (scheme === "dark" && vp.n === "1280") writeFileSync(`${OUT}/${s.id}.aria.yml`, await page.locator("body").ariaSnapshot());
      rows.push({ scene: s.id, scheme, vp: vp.n, overflowX: a.overflowX, small: a.small.length, unnamed: a.unnamed.length, dupIds: a.dupIds.length, headingJumps: a.headingJumps.length, lowContrast: a.lowContrast.length, focusStops: stops.length, focusNoRing: noRing.length, escape, pageErrors: errors.length, detail: { small: a.small.slice(0, 6), unnamed: a.unnamed.slice(0, 3), lowContrast: a.lowContrast.slice(0, 5), noRing: noRing.slice(0, 4), headingJumps: a.headingJumps.slice(0, 2), errors: errors.slice(0, 2) } });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
for (const r of rows) console.log(JSON.stringify({ ...r, detail: undefined }));
const bad = rows.filter((r) => r.overflowX || r.small || r.unnamed || r.dupIds || r.headingJumps || r.lowContrast || r.focusNoRing || r.escape === "STAYS OPEN" || r.pageErrors);
console.log(`\n${rows.length} views checked, ${bad.length} with findings`);
for (const r of bad) console.log("FINDING", r.scene, r.scheme, r.vp, JSON.stringify(r.detail));
writeFileSync(`${OUT}/results.json`, JSON.stringify(rows, null, 1));

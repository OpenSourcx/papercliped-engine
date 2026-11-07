// Accessibility audit (Playwright, in-page): accessible names for every interactive control, valid roles, image alt, dialog modal+name, heading order, duplicate ids, text contrast (WCAG AA) in both palettes. Needs the live host from live-ui-setup.mjs. HOST=<host> EXE=<chrome-headless-shell> node a11y-audit.mjs
import { chromium } from "/project/aftercard/node_modules/playwright-core/index.mjs";
const BASE = process.env.HOST, EXE = process.env.EXE;
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const h = { "X-EPC-Request": "1", "Content-Type": "application/json" };
const results = [];
async function audit(page, name) {
  const r = await page.evaluate(() => {
    const out = { unnamed: [], badRole: [], imgNoAlt: [], dialog: [], headings: [], lowContrast: [], duplicateIds: [], unlabeledInputs: [] };
    const nameOf = (e) => {
      const lb = e.getAttribute("aria-labelledby"); if (lb) return lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim();
      const al = e.getAttribute("aria-label"); if (al) return al.trim();
      if (e.labels?.length) return [...e.labels].map((l) => l.textContent).join(" ").trim();
      if (e.tagName === "INPUT" && e.placeholder && false) return e.placeholder;
      const t = (e.textContent || "").trim(); if (t) return t;
      return (e.getAttribute("title") || e.querySelector("img[alt]")?.getAttribute("alt") || e.querySelector("svg[aria-label]")?.getAttribute("aria-label") || "").trim();
    };
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    for (const e of document.querySelectorAll('a[href], button, [role=button], [role=switch], [role=radio], [role=tab], [role=checkbox], select, input:not([type=hidden]), textarea, summary')) { if (!vis(e)) continue; if (!nameOf(e)) out.unnamed.push(`${e.tagName.toLowerCase()}${e.getAttribute("role") ? `[${e.getAttribute("role")}]` : ""} ${e.outerHTML.slice(0, 90)}`); }
    const valid = new Set(["button", "switch", "radio", "radiogroup", "tab", "tablist", "tabpanel", "dialog", "alert", "status", "checkbox", "link", "listbox", "option", "menu", "menuitem", "img", "group", "region", "navigation", "list", "listitem", "presentation", "none", "separator", "progressbar", "tooltip", "combobox", "textbox", "slider", "log", "form", "main", "complementary", "banner", "search", "heading", "article", "table", "row", "cell", "columnheader", "rowheader", "grid", "gridcell", "tree", "treeitem", "menubar", "meter", "toolbar", "application", "switch", "alertdialog", "contentinfo", "figure", "paragraph", "term", "definition", "searchbox", "spinbutton", "scrollbar", "feed", "directory", "document", "math", "note", "marquee", "timer", "generic"]);
    for (const e of document.querySelectorAll("[role]")) { const r = e.getAttribute("role").split(" ")[0]; if (!valid.has(r)) out.badRole.push(r); }
    for (const e of document.querySelectorAll("img")) if (!e.hasAttribute("alt") && !e.closest("[aria-hidden=true]")) out.imgNoAlt.push(e.src.slice(-40));
    for (const d of document.querySelectorAll('[role=dialog]')) out.dialog.push({ modal: d.getAttribute("aria-modal"), name: nameOf(d).slice(0, 40) || (d.getAttribute("aria-labelledby") ? "labelledby" : "") });
    let last = 0; for (const hd of document.querySelectorAll("h1,h2,h3,h4")) { if (!vis(hd)) continue; const lv = +hd.tagName[1]; if (last && lv > last + 1) out.headings.push(`h${last}->h${lv} "${hd.textContent.trim().slice(0, 30)}"`); last = lv; }
    const ids = {}; for (const e of document.querySelectorAll("[id]")) ids[e.id] = (ids[e.id] || 0) + 1; out.duplicateIds = Object.entries(ids).filter(([, n]) => n > 1).map(([i]) => i);
    // contrast of visible text against the nearest opaque ancestor background
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bg = (e) => { let acc = { r: 0, g: 0, b: 0, a: 0 }; const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) layers.push(c); if (c && c.a >= 1) break; } let base = { r: 255, g: 255, b: 255 }; const root = parse(getComputedStyle(document.body).backgroundColor); if (root && root.a >= 1) base = root; for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; return base; };
    const seen = new Set();
    for (const e of document.querySelectorAll("p, span, div, label, button, a, h1, h2, h3, li, td, pre, strong")) {
      if (!vis(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(e); const fg = parse(cs.color); if (!fg) continue; const b = bg(e);
      const f = { r: fg.r * fg.a + b.r * (1 - fg.a), g: fg.g * fg.a + b.g * (1 - fg.a), b: fg.b * fg.a + b.b * (1 - fg.a) };
      const l1 = lum(f), l2 = lum(b); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700; const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const disabled = e.closest("[disabled], [aria-disabled=true]"); if (disabled) continue;
      if (ratio < need) { const k = (e.textContent || "").trim().slice(0, 28) + ratio.toFixed(1); if (!seen.has(k)) { seen.add(k); out.lowContrast.push(`${ratio.toFixed(2)}<${need} "${(e.textContent || "").trim().slice(0, 28)}"`); } }
    }
    return out;
  });
  results.push({ name, ...r });
}
const slugOf = async (page) => { const x = await page.request.fetch(BASE + "/engine/api/companies", { headers: h }); const co = (await x.json()).find((c) => c.name === "Live UI Co"); return co.issuePrefix.toLowerCase(); };
for (const scheme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  await ctx.addInitScript((sch) => { localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assist", aiProvider: "claude", pinAccess: { read: true, act: false }, completedAt: "2026-11-07T00:00:00Z" })); if (sch === "light") localStorage.setItem("epc.theme", JSON.stringify({ preset: "clip-light", mode: "fixed", accent: null, recentAccents: [], railAccent: true, radius: 0.625, transparency: true, glass: 55, glassBlur: 22, glassAlpha: 0.6, fontScale: 1 })); }, scheme);
  const page = await ctx.newPage();
  await page.request.post(BASE + "/api/login", { headers: h, data: { username: "sam", password: "right", realm: "pve" } });
  const slug = await slugOf(page);
  const pages = { "org-apps": `/pve/${slug}/connectors?section=apps`, "access-people": `/pve/home?settings=access`, "access-remote": `/pve/home?settings=access&access=remote`, "plugins": `/pve/home?settings=community-plugins` };
  for (const [n, u] of Object.entries(pages)) { await page.goto(BASE + u, { waitUntil: "networkidle" }); await page.waitForTimeout(1500); await audit(page, `${scheme} ${n}`); }
  await page.goto(BASE + pages["org-apps"], { waitUntil: "networkidle" }); await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Agent access|Review and enforce access/ }).first().click(); await page.waitForTimeout(1200); await audit(page, `${scheme} agent-access dialog`);
  await ctx.close();
}
for (const r of results) console.log(JSON.stringify({ name: r.name, unnamed: r.unnamed.length, badRole: r.badRole.length, imgNoAlt: r.imgNoAlt.length, dialogs: r.dialog, headingJumps: r.headings.length, duplicateIds: r.duplicateIds.length, lowContrast: r.lowContrast.length }));
console.log("DETAIL", JSON.stringify(results.map((r) => ({ n: r.name, unnamed: r.unnamed.slice(0, 5), lowContrast: r.lowContrast.slice(0, 8), headings: r.headings.slice(0, 3), dup: r.duplicateIds.slice(0, 3) })), null, 0).slice(0, 4500));
await browser.close();

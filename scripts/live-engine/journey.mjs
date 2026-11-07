// Complete owner journey against the real host + real engine (see docs/STABLE-V1-LEDGER.md, "Complete owner journey").
// HOST=<host-live address> EXE=<chrome-headless-shell> node journey.mjs   (fresh engine; scripts/live-engine/mcp-fake.mjs must be running on :3188)
import { chromium } from "/project/aftercard/node_modules/playwright-core/index.mjs";
const BASE = process.env.HOST, EXE = process.env.EXE;
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
const H = { "X-EPC-Request": "1", "Content-Type": "application/json" };
const shot = (n) => page.screenshot({ path: `/project/.work/shots/journey-${n}.png` });
const body = async (n = 400) => (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, n);
const ORG = `Journey ${Date.now().toString(36)}`;
const rows = []; const rec = (step, what, status, note = "") => { rows.push({ step, what, status, note }); console.log(`[${status}] ${step} ${what}${note ? " — " + note : ""}`); };
const api = async (method, path, data) => { const x = await page.request.fetch(BASE + "/engine" + path, { method, headers: H, data }); let j; try { j = await x.json(); } catch { j = null; } return { s: x.status(), j }; };
const go = async (u) => { await page.goto(BASE + u, { waitUntil: "networkidle" }); await page.waitForTimeout(1500); };
const names = async () => (await page.locator("button:visible").allInnerTexts()).map((x) => x.trim().replace(/\s+/g, " "));

// 1. first run, sign-in, setup
await go("/"); rec("1", "sign-in page", (await page.getByLabel("Username").count()) ? "live" : "missing");
await page.getByLabel("Username").fill("sam"); await page.getByLabel("Password").fill("wrong"); await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForTimeout(1500);
rec("1", "wrong password shows an error and stays on sign-in", /incorrect|invalid|failed|try again|wrong/i.test(await body(800)) ? "live" : "gap", (await body(300)).slice(0, 160));
await page.getByLabel("Password").fill("right"); await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForTimeout(3500);
rec("1", "sign-in lands on first-run setup", page.url().includes("/setup") ? "live" : "gap", page.url().replace(BASE, ""));
for (let i = 0; i < 8 && page.url().includes("/setup"); i++) { const n = await names(); const pick = ["Do this later", "Continue", "Meet Pin"].find((x) => n.includes(x)); if (!pick) break; await page.getByRole("button", { name: pick, exact: true }).click(); await page.waitForTimeout(1800); }
rec("1", "setup finishes on the device home", page.url().includes("/pve/home") ? "live" : "gap", page.url().replace(BASE, ""));

// 2. Access / Connect
await go("/pve/home?settings=access&access=remote");
const t2 = await body(6000);
rec("2", "Access page has Remote access with Local only active and Connect choice", /Local only/.test(t2) && /Papercliped Connect/.test(t2) ? "live" : "gap");
rec("2", "provider sign-in address shown for this device", /Provider sign-in address/.test(t2) ? "live" : "gap");
rec("2", "pairing and tunnel with the real Connect service", "not run", "would create a pairing in production Connect; exercised only against fakes");

// 3. organization + CEO
await go("/pve/home?modal=new-org");
await page.getByLabel(/Name/i).first().fill(ORG); await page.getByRole("button", { name: "Continue" }).first().click(); await page.waitForTimeout(2500);
const t3 = await body(900);
rec("3", "organization wizard creates the organization in the engine", (await api("GET", "/api/companies")).j?.some((c) => c.name === ORG) ? "live" : "gap");
rec("3", "wizard shows a resource-group problem on a device without the broker", /resource broker|nowhere to run/.test(t3) ? "gap" : "live", /resource broker|nowhere to run/.test(t3) ? "blocked by the broker step (fixed in this pass: step is skipped)" : "no blocking warning");
await page.getByLabel(/Agent name/i).fill("Ada"); await page.getByLabel(/Role/i).fill("Chief of staff");
await page.getByRole("button", { name: "Next" }).click(); await page.waitForTimeout(2500);
console.log("3 step3:", (await body(700)).slice(-300), "|", (await names()).slice(-6).join(" / ")); await shot("3-step3");
for (let i = 0; i < 4 && /modal=new-org|setup/.test(page.url() + "modal"); i++) { const n = await names(); const pick = ["Create task", "Skip", "Next", "Open Journey Labs", "Open the organization", "Finish", "Done"].find((x) => n.includes(x)) ?? n.find((x) => /^(Open|Finish|Skip)/.test(x)); if (!pick) break; await page.getByRole("button", { name: pick }).first().click().catch(() => {}); await page.waitForTimeout(2200); console.log("3 next:", pick, "|", (await body(200))); if (!(await page.locator("[role=dialog], .fixed").count())) break; }
const co = (await api("GET", "/api/companies")).j?.find((c) => c.name === ORG); const slug = co?.issuePrefix?.toLowerCase();
const agents = co ? (await api("GET", `/api/companies/${co.id}/agents`)).j : [];
rec("3", "CEO/first agent exists in the engine", agents?.some((a) => a.name === "Ada") ? "live" : "gap", `agents: ${(agents ?? []).map((a) => a.name + ":" + a.status).join(", ")}`);

// 4. resources
await go(`/pve/${slug}/settings`);
const t4 = await body(1200);
rec("4", "organization settings show the resource group and provisioning state", /Resource group/.test(t4) ? "live" : "gap", (t4.match(/Provisioning[^·]{0,60}/) ?? [""])[0]);
rec("4", "resource group is Ready without a broker", /Ready/.test(t4) ? "live" : "gap");
const rg = (await page.request.fetch(BASE + "/api/resource-groups", { headers: H })).status(); rec("4", "resource-group API", rg === 200 ? "live" : "gap");
rec("4", "quota enforcement in the real Proxmox allocation path", "not run", "needs a Proxmox host; provider quota tested against a fake Proxmox only");

// 5. agents + hierarchy
await go(`/pve/${slug}/agents`); const t5 = await body(600);
rec("5", "agents page lists the CEO with a status badge", /Ada/.test(t5) ? "live" : "gap", t5.slice(0, 120));
const n5 = await names(); rec("5", "a visible way to add an agent", n5.some((x) => /New agent|Add agent|Hire|Create agent/i.test(x)) ? "live" : "gap", n5.filter((x) => /agent/i.test(x)).slice(0, 4).join(" / "));
await go(`/pve/${slug}/org`); rec("5", "organization chart renders the hierarchy", /Ada/.test(await body(900)) ? "live" : "gap");
rec("5", "agents run (model execution)", "not run", "agent containers are not set up in this fake-Proxmox host; no model credentials");

// 6. connect an app, set Off/Ask/Allow
const conn = (await api("POST", `/api/companies/${co.id}/tools/apps/connect`, { link: "http://127.0.0.1:3188/mcp", name: "Notes", authMode: "none", grantKind: "organization" })).j;
await api("POST", `/api/tool-connections/${conn.connectionId}/catalog/refresh`, {});
await api("POST", `/api/companies/${co.id}/tools/apps/${conn.connectionId}/finish`, { preserveExistingAccess: false, access: { agentIds: [] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] });
await go(`/pve/${slug}/connectors?section=apps`);
const t6 = await body(9000);
rec("6", "Organization apps shows the connection with a health label and actions available", /Notes/.test(t6) && /Healthy/.test(t6) && /3 actions available/.test(t6) ? "live" : "gap");
rec("6", "a connection finished through the host is enforced from the start (no not-enforced flag)", /not enforced/i.test(t6) ? "gap" : "live", "pre-fix connections get the flag; covered by unit tests and the real-policy live test, not this page");
rec("6", "provider setup through the UI for a custom MCP link", "missing", "UI offers gallery apps only (GitHub, Slack, Discord, Notion); a custom MCP link can be connected only through the engine API");
await page.getByRole("button", { name: "Agent access" }).first().click(); await page.waitForTimeout(1500);
await page.getByLabel("read_note").selectOption("allow"); await page.getByLabel("write_note").selectOption("ask");
const sw = page.getByRole("switch", { name: "Ada" }); if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
await page.getByRole("button", { name: "Save access" }).click(); await page.waitForTimeout(3500);
const ada = (await api("GET", `/api/companies/${co.id}/agents`)).j.find((a) => a.name === "Ada");
// The host's engine proxy does not expose test-calls, so read the saved policies and profile (the enforcement itself is proven by the live engine tests).
const cat = (await api("GET", `/api/tool-connections/${conn.connectionId}/catalog`)).j.catalog; const cid = (n) => cat.find((c) => c.toolName === n).id;
const pols = (await api("GET", `/api/companies/${co.id}/tools/policies`)).j.policies.filter((p) => p.name.startsWith(`ePaperclip app:${conn.connectionId}:`));
const has = (n, t) => pols.some((p) => p.name.endsWith(`:${n}:${cid(t)}`) && p.enabled);
rec("6", "UI save writes an Allow rule for read_note", has("allow", "read_note") ? "live" : "gap");
rec("6", "UI save writes an Ask-first rule for write_note", has("ask", "write_note") ? "live" : "gap");
rec("6", "UI save writes no rule for delete_note and a connection-wide default deny (Off is enforced)", !pols.some((p) => p.name.includes(cid("delete_note"))) && pols.some((p) => p.name.endsWith(":default") && p.policyType === "block") ? "live" : "gap");
rec("6", "UI save binds the selected agent", (await api("GET", `/api/companies/${co.id}/tools/profiles`)).j.profiles.some((p) => p.profileKey === `app:${conn.connectionId}` && p.bindings.some((b) => b.targetId === ada.id)) ? "live" : "gap");
await go(`/pve/${slug}/connectors?section=apps`);

// 7. Pin: held actions, approvals, chat
rec("7", "Held app actions card is present and says nothing is waiting", /Held app actions/.test(await body(9000)) && /Nothing is waiting/.test(await body(9000)) ? "live" : "gap");
rec("7", "a held action appearing in the card and being approved from it", "engine-live tests only", "the host's engine proxy exposes no test-calls route, so this page cannot create one; Pin/MCP live tests create and approve one against the real engine, and the card is unit-tested with the engine's real response shape");
await page.getByRole("button", { name: "Let Pin use apps here" }).click().catch(() => {}); await page.waitForTimeout(2500);
rec("7", "Pin card enables Pin's identity (paused engine agent)", (await api("GET", `/api/companies/${co.id}/agents`)).j.some((a) => a.name === "Pin (host)" && a.status === "paused") ? "live" : "gap");
await go("/pve/home");
const pinInput = page.getByPlaceholder(/Ask|Message|anything/i).first();
if (await pinInput.count()) { await pinInput.fill("hello"); await pinInput.press("Enter"); await page.waitForTimeout(3500); rec("7", "Pin chat without a connected model explains what to do", /connect|account|model|Connectors/i.test(await body(2500)) ? "live" : "gap", (await body(2500)).slice(-200)); } else rec("7", "Pin chat input", "gap", "no input found");
rec("7", "Pin chat with a real model, Pin acting on a real provider", "not run", "no model credentials or real provider in this environment");

// 8. channels
await go(`/pve/${slug}/connectors?section=apps`);
await page.getByRole("button", { name: "Chat with an agent" }).first().click().catch(() => {}); await page.waitForTimeout(1500);
const t8 = await body(9000); rec("8", "channel setup dialog opens (Slack/Discord)", /agent channel|Choose an agent/.test(t8) ? "live" : "gap");
await page.getByLabel("Agent", { exact: true }).selectOption({ label: "Ada (not ready to run yet)" }).catch((e) => console.log("agent select:", e.message.slice(0, 80))); await page.getByRole("button", { name: "Continue to provider setup" }).click().catch(() => {}); await page.waitForTimeout(2500);
const t8b = await body(9000); const eps = (await api("GET", `/api/companies/${co.id}/chat-endpoints`)).j;
rec("8", "choosing a paused agent shows the warning, and the engine's refusal is shown as plain text (new agents are not active until agent containers are set up)", /cannot run yet/.test(t8b) && /must be active/.test(t8b) ? "live" : "gap", `endpoints: ${Array.isArray(eps) ? eps.length : "?"}`);
rec("8", "native chat endpoint creation with an active agent", "not run", "needs an active agent (agent containers + verified adapter); endpoint creation is covered by the snapshot's unit tests only");
rec("8", "real Slack/Discord bot, signed inbound events, identity link, replies", "not run", "needs real provider credentials");

// 9. plugins
await go("/pve/home?settings=community-plugins"); const t9 = await body(9000);
rec("9", "Community plugins loads against the engine and explains the missing catalog key", /Community plugins/.test(t9) && /No trusted catalog/.test(t9) ? "live" : "gap");

// 10. sign out / in, mobile
await go("/pve/home?settings=general"); const so = page.getByRole("button", { name: /Sign out/i });
rec("10", "Sign out is reachable from the account link (Settings, General)", (await so.count()) ? "live" : "gap");
await so.first().click().catch(() => {}); await page.waitForTimeout(2000);
rec("10", "signing out returns to the sign-in page", (await page.getByLabel("Username").count()) ? "live" : "gap");
await ctx.close();
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p2 = await ctx2.newPage();
await p2.goto(BASE + "/", { waitUntil: "networkidle" });
rec("10", "after losing the session the sign-in page is shown (mobile)", (await p2.getByLabel("Username").count()) ? "live" : "gap");
await p2.getByLabel("Username").fill("sam"); await p2.getByLabel("Password").fill("right"); await p2.getByRole("button", { name: "Sign in" }).click(); await p2.waitForTimeout(3000);
rec("10", "sign-in works on a phone-size screen", /pve\/home|setup/.test(p2.url()) ? "live" : "gap", p2.url().replace(BASE, ""));
await p2.goto(`${BASE}/pve/${slug}/connectors?section=apps`, { waitUntil: "networkidle" }); await p2.waitForTimeout(1500);
rec("10", "organization apps usable at 390px without horizontal scroll", await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth) ? "live" : "gap");
console.log("JSON", JSON.stringify(rows));
await browser.close();

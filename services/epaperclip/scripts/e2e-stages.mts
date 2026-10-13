// The stages of the end-to-end run (see e2e-real-engine.mts). Each stage is one part of the v1 story; a failing stage is
// recorded with its error and a screenshot and the run goes on, so one run lists everything that is wrong.
import { join } from "node:path";
import type { createApp } from "../src/app.ts";
import type { SessionStore } from "../src/sessions.ts";
import type { StateStore } from "../src/state.ts";
import type { fakeSsh } from "../test/fakes.ts";
import type { fakeE2ePve, ProviderScript } from "../test/fakes-e2e.ts";
import type { startPinRuntime } from "../src/features/pin-automations.ts";

export interface Ctx {
  base: string;
  engineUrl: string;
  app: ReturnType<typeof createApp>;
  pve: ReturnType<typeof fakeE2ePve>;
  provider: ProviderScript;
  ssh: ReturnType<typeof fakeSsh>;
  state: StateStore;
  clock: { skew: number };
  pinClock: { t: number };
  pin: ReturnType<typeof startPinRuntime>;
  sessions: SessionStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  browser: any;
  shots: string;
  only: string[];
  engineLog: () => string;
}
export interface Result {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runStages(c: Ctx): Promise<Result[]> {
  const results: Result[] = [];
  const problems: string[] = [];
  const S: { org?: { id: string; name: string }; [k: string]: unknown } = {};

  // ---- browser helpers
  const users = new Map<string, { ctx: Page; page: Page }>();
  const open = async (user: string, width = 1440): Promise<{ ctx: Page; page: Page }> => {
    const have = users.get(user);
    if (have) return have;
    const ctx = await c.browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    let where = "";
    page.on("pageerror", (e: Error) => problems.push(`[${user}] page error at ${where || page.url()}: ${e.message}`));
    page.on("console", (m: { type(): string; text(): string }) => {
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(`[${user}] console error at ${page.url()}: ${m.text().slice(0, 200)}`);
    });
    page.on("response", (r: { status(): number; url(): string; request(): { method(): string } }) => {
      const u = new URL(r.url());
      if (r.status() >= 500 && u.origin === c.base) problems.push(`[${user}] ${r.request().method()} ${u.pathname} -> ${r.status()}`);
    });
    page.on("framenavigated", () => (where = page.url()));
    const entry = { ctx, page };
    users.set(user, entry);
    return entry;
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: join(c.shots, `${name}.png`), fullPage: true }).catch(() => undefined);
  const signInUi = async (page: Page, username: string, password = "right") => {
    await page.goto(c.base + "/");
    await page.waitForSelector("text=Sign in to ePaperclip", { timeout: 15000 });
    await page.fill('input[autocomplete="username"]', username);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
  };

  const stage = async (name: string, fn: () => Promise<void>) => {
    if (c.only.length && !c.only.some((w) => name.toLowerCase().includes(w.toLowerCase()))) return;
    const t0 = Date.now();
    const before = problems.length;
    try {
      await fn();
      const fresh = problems.splice(before);
      if (fresh.length) throw new Error("browser problems:\n  " + fresh.join("\n  "));
      results.push({ name, ok: true, ms: Date.now() - t0 });
      console.log(`  ok   ${name}`);
    } catch (e) {
      problems.length = before;
      const err = e instanceof Error ? e.message : String(e);
      results.push({ name, ok: false, error: err, ms: Date.now() - t0 });
      console.log(`  FAIL ${name}\n       ${err.split("\n").join("\n       ")}`);
      for (const [u, { page }] of users) await shot(page, `FAIL-${name.replace(/\W+/g, "-")}-${u}`);
    }
  };

  // ---- API helpers (the browser's own session, so the host sees the same person)
  const call = async (user: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> => {
    const { ctx } = await open(user);
    const r = await ctx.request.fetch(c.base + path, { method, headers: { "X-EPC-Request": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, data: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status(), json, text };
  };
  const eng = (user: string, method: string, path: string, body?: unknown) => call(user, method, "/engine" + path, body);
  const expect = (cond: unknown, msg: string): asserts cond => {
    if (!cond) throw new Error(msg);
  };
  const until = async <T,>(what: string, fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 20000): Promise<T> => {
    const t0 = Date.now();
    let last: unknown;
    for (;;) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) { last = e; }
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}${last ? ` (${last instanceof Error ? last.message : last})` : ""}`);
      await sleep(250);
    }
  };
  /** Signs a person in through the console's form and finishes the first-run questions if they come up. */
  const signedIn = async (user: string) => {
    const { page } = await open(user);
    await signInUi(page, user);
    await page.waitForSelector("text=/What should Pin call you|Good (morning|afternoon|evening)/", { timeout: 20000 });
    if (await page.locator("text=What should Pin call you?").count()) {
      for (let i = 0; i < 6 && !(await page.locator("button:has-text('Meet Pin')").count()); i++) {
        if (await page.locator("button:has-text('Do this later')").count()) await page.click("button:has-text('Do this later')");
        else await page.click("button:has-text('Continue')");
        await page.waitForTimeout(200);
      }
      await page.click("button:has-text('Meet Pin')");
    }
    await page.waitForURL("**/home", { timeout: 15000 });
    await page.waitForSelector("text=THIS DEVICE", { timeout: 15000 });
    return page;
  };
  /** The engine makes a Proxmox administrator an instance admin shortly after sign-in, in the background. */
  const engineAdmin = (user: string) => until(`${user} to be an engine instance admin`, async () => (await eng(user, "GET", "/api/companies")).status === 200 && (await eng(user, "GET", "/api/admin/users")).status === 200);
  const bodyText = async (page: Page) => (await page.innerText("body")).replace(/\s+/g, " ");

  // ---- stages
  await stage("admin: sign in with a Proxmox account and finish first-run setup", async () => {
    const page = await signedIn("sam");
    await shot(page, "01-admin-home");
    const t = await bodyText(page);
    expect(/Good (morning|afternoon|evening), sam/.test(t), "the greeting names the signed-in person");
    expect(/2 \/ 3\s*Machines running/.test(t), "the three machines Proxmox lists are shown");
    for (const n of ["web", "cache", "db"]) expect(t.includes(n), `machine ${n} is listed`);
    await engineAdmin("sam");
  });

  await stage("non-admin: sign in, see the device, cannot create organizations", async () => {
    const page = await signedIn("lee");
    await shot(page, "02-nonadmin-home");
    const t = await bodyText(page);
    expect(/Good (morning|afternoon|evening), lee/.test(t), "the greeting names lee");
    const created = await eng("lee", "POST", "/api/companies", { name: "Sneaky" });
    expect(created.status === 403, `a non-admin creating an organization is refused, got ${created.status} ${created.text.slice(0, 120)}`);
    const list = await eng("lee", "GET", "/api/companies");
    expect(list.status === 200 && Array.isArray(list.json) && list.json.length === 0, `lee sees no organizations, got ${list.text.slice(0, 120)}`);
    const claim = await eng("lee", "POST", "/api/bootstrap/claim", {});
    expect(claim.status >= 400, `a non-admin can't claim the instance, got ${claim.status}`);
    const accessApi = await call("lee", "POST", "/api/iac/users", { userid: "x@pve" });
    expect(accessApi.status >= 400, "a non-admin can't create users");
  });

  await stage("admin: create an organization; the engine and Proxmox both get it", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/home?modal=new-org");
    await page.fill('input[placeholder="e.g. Northwind Labs"]', "Acme Labs");
    await page.fill("textarea", "Builds anvils");
    await shot(page, "03-new-org");
    await page.click("button:has-text('Create organization')");
    await page.waitForURL(/\/pve\/acm$/, { timeout: 20000 });
    await page.waitForSelector("text=RESOURCE GROUP");
    const list = await eng("sam", "GET", "/api/companies");
    const co = list.json.find((x: any) => x.name === "Acme Labs");
    expect(co, "the engine lists Acme Labs");
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(co.id), `the organization id is a UUID, got ${co.id}`);
    S.org = { id: co.id, name: co.name };
    const groups = await call("sam", "GET", "/api/resource-groups");
    const g = groups.json.groups.find((x: any) => x.companyId === co.id);
    expect(g && g.pool === "epc-acme-labs", `a resource group with pool epc-acme-labs was saved, got ${groups.text}`);
    expect(c.pve.pools.has("epc-acme-labs"), "Proxmox has the pool epc-acme-labs");
    const members = await eng("sam", "GET", `/api/companies/${co.id}/members`);
    expect(members.status === 200, `members listed, got ${members.status}`);
    // The creator is an owner in the engine and an owner on the pool in Proxmox.
    const poolAcl = c.pve.acl.filter((a) => a.path === "/pool/epc-acme-labs");
    expect(poolAcl.some((a) => a.ugid === "sam@pve" && a.roleid === "PVEPoolAdmin"), `sam has PVEPoolAdmin on the pool, ACLs: ${JSON.stringify(poolAcl)}`);
    await shot(page, "03-org-dashboard");
    // Lee (not a member) still sees nothing of it.
    const lee = await eng("lee", "GET", `/api/companies/${co.id}`);
    expect(lee.status >= 400, `a non-member can't read the organization, got ${lee.status}`);
  });

  return results;
}

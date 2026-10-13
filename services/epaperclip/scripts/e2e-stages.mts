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
  /** The control inside the <label> whose first line is this text (the engine pages wrap their inputs in labels). */
  const field = (page: Page, label: string) => page.locator("label").filter({ has: page.locator("span", { hasText: new RegExp(`^${label}\\b`) }) }).locator("input, select, textarea").first();
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

  const poolAcl = () => c.pve.acl.filter((a) => a.path === "/pool/epc-acme-labs");
  const openUser = async (page: Page, userid: string) => {
    await page.goto(c.base + "/pve/home?settings=access");
    await page.click(`button:has-text("${userid}")`);
    await page.waitForSelector("text=Save changes");
  };
  const orgMembers = async (): Promise<any[]> => {
    const r = await eng("sam", "GET", `/api/companies/${S.org!.id}/members`);
    expect(r.status === 200, `members listed, got ${r.status}`);
    const list = Array.isArray(r.json) ? r.json : r.json?.members;
    expect(Array.isArray(list), `members is a list, got ${r.text.slice(0, 200)}`);
    return list;
  };

  await stage("access: give kim a role in the organization; Proxmox ACLs and engine membership follow", async () => {
    const { page } = await open("sam");
    await openUser(page, "kim@pve");
    await page.getByLabel("Role in Acme Labs").selectOption("operator");
    await shot(page, "04-iac-kim-operator");
    await page.click("button:has-text('Save changes')");
    await until("kim's ACL on the pool", () => poolAcl().some((a) => a.ugid === "kim@pve"));
    expect(poolAcl().some((a) => a.ugid === "kim@pve" && a.roleid === "PVEVMUser"), `kim has PVEVMUser on the pool, got ${JSON.stringify(poolAcl())}`);
    expect(!c.pve.acl.some((a) => a.ugid === "kim@pve" && a.path === "/"), "kim got no device-wide access");
    const kim = await until("the engine to list kim as a member", async () => (await orgMembers()).find((m) => m.user?.name === "kim" || JSON.stringify(m.user ?? {}).includes("kim.pve")));
    expect(kim.membershipRole === "operator" && kim.status === "active", `kim's engine role is operator, got ${JSON.stringify(kim)}`);
    await page.goto(c.base + `/pve/acm/members`);
    await page.waitForSelector("text=kim");
    await shot(page, "04-members");
  });

  await stage("access: create a user with a role in the organization", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/home?settings=access");
    await page.click("button:has-text('New user')");
    await page.fill('input[placeholder="sam@pve"]', "ana@pve");
    await page.fill('input[type="password"]', "an-okay-passphrase");
    await page.getByLabel("Role in Acme Labs").selectOption("viewer");
    await page.click("button:has-text('Create user')");
    await until("ana in Proxmox", () => c.pve.users.has("ana@pve"));
    await until("ana's pool ACL", () => poolAcl().some((a) => a.ugid === "ana@pve"));
    expect(poolAcl().some((a) => a.ugid === "ana@pve" && a.roleid === "PVEAuditor"), `ana has PVEAuditor on the pool, got ${JSON.stringify(poolAcl())}`);
    const asAna = await fetch(c.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "ana", password: "an-okay-passphrase", realm: "pve" }) });
    expect(asAna.status === 200, `the new user can sign in with the password, got ${asAna.status}`);
  });

  await stage("access: the member signs in and sees only their organization; role changes and removal reach Proxmox", async () => {
    const kim = await signedIn("kim");
    await kim.waitForSelector("text=Acme Labs", { timeout: 20000 });
    await shot(kim, "05-kim-home");
    const own = await eng("kim", "GET", "/api/companies");
    expect(own.json.length === 1 && own.json[0].id === S.org!.id, `kim sees exactly Acme Labs, got ${own.text.slice(0, 200)}`);
    expect((await eng("kim", "POST", "/api/companies", { name: "Nope" })).status === 403, "kim can't create organizations");
    await kim.goto(c.base + "/pve/acm");
    await kim.waitForSelector("text=RESOURCE GROUP");
    const settingsEdit = await call("kim", "PUT", `/api/resource-groups/${S.org!.id}`, { name: "Acme Labs", cores: 99, memoryMb: 1024, diskGb: 1, maxGuests: 1 });
    expect(settingsEdit.status === 403, `an operator can't change the organization's resources, got ${settingsEdit.status}`);
    const { page } = await open("sam");
    await openUser(page, "kim@pve");
    await page.getByLabel("Role in Acme Labs").selectOption("viewer");
    await page.click("button:has-text('Save changes')");
    await until("kim becomes an auditor", () => poolAcl().some((a) => a.ugid === "kim@pve" && a.roleid === "PVEAuditor"));
    expect(!poolAcl().some((a) => a.ugid === "kim@pve" && a.roleid === "PVEVMUser"), "the operator role was taken away");
    await openUser(page, "kim@pve");
    await page.getByLabel("Role in Acme Labs").selectOption("");
    await page.click("button:has-text('Save changes')");
    await until("kim's pool ACLs removed", () => !poolAcl().some((a) => a.ugid === "kim@pve"));
    await until("kim to leave the engine membership", async () => !(await orgMembers()).some((m) => (m.user?.name === "kim") && m.status === "active"));
    // Taking someone's organization role away ends their open sessions, so a stale tab can't keep working.
    expect((await eng("kim", "GET", "/api/companies")).status === 401, "kim's open session ended when her access was removed");
    const again = await fetch(c.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "kim", password: "right", realm: "pve" }) });
    const cookie = again.headers.get("set-cookie")!.split(";")[0];
    const fresh = await fetch(c.base + "/engine/api/companies", { headers: { Cookie: cookie } });
    expect(fresh.status === 200 && (await fresh.json()).length === 0, "signing in again, kim sees no organizations");
  });

  await stage("agents: create an agent through the console; its pages open against the real engine", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/agents");
    await page.click("button:has-text('New agent')");
    await field(page, "Name").fill("Runner");
    await field(page, "Role").selectOption("engineer");
    const runsWith = await field(page, "Runs with").inputValue();
    expect(runsWith !== "process", `the default adapter can run in a container; "process" can't (default was ${runsWith})`);
    await shot(page, "06-new-agent");
    await page.click("button:has-text('Create agent')");
    await page.waitForURL(/\/pve\/acm\/agents\/[0-9a-f-]{36}$/, { timeout: 20000 });
    S.agentId = page.url().split("/").pop();
    const list = await eng("sam", "GET", `/api/companies/${S.org!.id}/agents`);
    const a = list.json.find((x: any) => x.id === S.agentId);
    expect(a && a.name === "Runner" && a.role === "engineer", `the engine has the agent, got ${list.text.slice(0, 300)}`);
    expect(/^[0-9a-f-]{36}$/.test(a.id), "agent ids are UUIDs");
    for (const tab of ["Overview", "Runs", "Configuration", "Instructions", "Skills", "Budget"]) {
      await page.getByRole("tab", { name: tab }).or(page.getByRole("button", { name: tab, exact: true })).first().click();
      await page.waitForTimeout(700);
      await shot(page, `06-agent-${tab.toLowerCase()}`);
    }
  });

  await stage("tasks: create a task for the agent; the run fails closed because there is no container", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/tasks");
    await page.click("button:has-text('New task')");
    await page.fill('input[placeholder="What needs doing?"]', "Sharpen the anvils");
    await page.fill("textarea", "All twelve of them.");
    await page.locator("select").filter({ hasText: "Unassigned" }).selectOption({ label: "Runner" });
    await shot(page, "07-new-task");
    await page.click("button:has-text('Create task')");
    await page.waitForSelector("text=Sharpen the anvils");
    const issues = await eng("sam", "GET", `/api/companies/${S.org!.id}/issues`);
    const t = (Array.isArray(issues.json) ? issues.json : issues.json.issues).find((x: any) => x.title === "Sharpen the anvils");
    expect(t, `the engine has the task, got ${issues.text.slice(0, 200)}`);
    expect(t.identifier === "ACM-1" && t.assigneeAgentId === S.agentId, `the task is ACM-1 and assigned to the agent, got ${t.identifier} ${t.assigneeAgentId}`);
    S.taskId = t.id;
    // Assigning wakes the agent; with no agent containers the engine's managed-sandbox-only policy refuses the run.
    const runs = await until("a failed run", async () => {
      const r = await eng("sam", "GET", `/api/companies/${S.org!.id}/heartbeat-runs?agentId=${S.agentId}`);
      const list = Array.isArray(r.json) ? r.json : r.json?.runs ?? [];
      return list.find((x: any) => x.status === "failed") ? list : null;
    }, 30000);
    const failed = runs.find((x: any) => x.status === "failed");
    const why = `${failed.error ?? ""} ${failed.errorCode ?? ""}`;
    console.log("       run failed with:", why.trim().slice(0, 200));
    expect(/managed sandbox|local execution|sandbox/i.test(why), `the run failed because of the sandbox policy, got: ${why}`);
    expect(!runs.some((x: any) => x.status === "running" || x.status === "succeeded"), "no run started on the host");
    await page.goto(c.base + `/pve/acm/tasks/${t.id}`);
    await page.waitForSelector("text=Sharpen the anvils");
    await shot(page, "07-task-detail");
    await page.goto(c.base + `/pve/acm/agents/${S.agentId}`);
    await page.waitForSelector("text=Runner");
    await page.getByRole("tab", { name: "Runs" }).or(page.getByRole("button", { name: "Runs", exact: true })).first().click();
    await page.waitForTimeout(1200);
    await shot(page, "07-agent-runs-failed");
    const wake = await eng("sam", "POST", `/api/agents/${S.agentId}/wakeup`, { source: "on_demand", triggerDetail: "manual" });
    console.log("       manual wakeup:", wake.status, wake.text.slice(0, 160));
  });

  return results;
}

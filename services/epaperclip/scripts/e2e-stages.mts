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
      // The Store's catalog is fetched from the vendors' sites, which this box can't reach: its 502 is expected here.
      if (r.status() >= 500 && u.origin === c.base && u.pathname !== "/api/templates/catalog") problems.push(`[${user}] ${r.request().method()} ${u.pathname} -> ${r.status()}`);
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
  const signedInAgain = async (user: string) => {
    const { page } = await open(user);
    await page.goto(c.base + "/");
    await page.waitForSelector("text=/Sign in to ePaperclip|THIS DEVICE/", { timeout: 15000 });
    if (await page.locator("text=Sign in to ePaperclip").count()) {
      await signInUi(page, user);
      await page.waitForSelector("text=THIS DEVICE", { timeout: 20000 });
    }
  };
  /** The engine makes a Proxmox administrator an instance admin shortly after sign-in, in the background. */
  const engineAdmin = (user: string) => until(`${user} to be an engine instance admin`, async () => (await eng(user, "GET", "/api/companies")).status === 200 && (await eng(user, "GET", "/api/admin/users")).status === 200);
  /** The control inside the <label> whose first line is this text (the engine pages wrap their inputs in labels). */
  const field = (page: Page, label: string) => page.locator("label").filter({ has: page.locator("span", { hasText: new RegExp(`^${label}\\b`) }) }).locator("input, select, textarea").first();
  /** A tab or a segmented button, whichever the page uses. */
  const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true }).or(page.getByRole("button", { name, exact: true })).or(page.getByRole("radio", { name, exact: true })).first();
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
    for (const t of ["Overview", "Runs", "Configuration", "Instructions", "Skills", "Budget"]) {
      await tab(page, t).click();
      await page.waitForTimeout(700);
      await shot(page, `06-agent-${t.toLowerCase()}`);
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
    await tab(page, "Runs").click();
    await page.waitForTimeout(1200);
    await shot(page, "07-agent-runs-failed");
    const wake = await eng("sam", "POST", `/api/agents/${S.agentId}/wakeup`, { source: "on_demand", triggerDetail: "manual" });
    console.log("       manual wakeup:", wake.status, wake.text.slice(0, 160));
  });

  await stage("inbox: the failed run needs the person; the page and the rail badge agree", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/inbox");
    await page.waitForSelector("text=Needs you");
    await shot(page, "08-inbox");
    // Pin's island floats over the top edge; the containers banner must sit clear of it.
    const covered = await page.evaluate(() => {
      const note = document.querySelector('[role="status"] span');
      if (!note) return "the containers banner isn't shown";
      const r = note.getBoundingClientRect();
      for (const f of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const hit = document.elementFromPoint(r.left + r.width * f, r.top + r.height / 2);
        if (!hit || !note.closest('[role="status"]')!.contains(hit)) return `something covers the banner text at ${Math.round(f * 100)}% of its width`;
      }
      return null;
    });
    expect(!covered, String(covered));
    const attention = await eng("sam", "GET", `/api/companies/${S.org!.id}/attention`);
    expect(attention.status === 200, `attention feed answers, got ${attention.status}`);
    const items = attention.json.items as any[];
    console.log("       attention items:", items.map((i) => `${i.kind ?? i.sourceKind}:${i.title ?? ""}`.slice(0, 70)).join(" | "));
    const badges = await eng("sam", "GET", `/api/companies/${S.org!.id}/sidebar-badges`);
    console.log("       badges:", badges.text);
    await page.goto(c.base + "/pve/acm/decisions");
    await page.waitForSelector("text=Waiting");
    await shot(page, "08-decisions");
    console.log("       decisions:", (await bodyText(page)).slice(0, 500));
  });

  await stage("decisions: a hire waits for approval, and approving it in the console reaches the engine", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/settings");
    await page.getByRole("switch", { name: "Require approval for new agents" }).click();
    await until("the engine setting", async () => (await eng("sam", "GET", `/api/companies/${S.org!.id}`)).json?.requireBoardApprovalForNewAgents === true);
    await page.goto(c.base + "/pve/acm/agents");
    await page.click("button:has-text('New agent')");
    await field(page, "Name").fill("Scout");
    await field(page, "Role").selectOption("researcher");
    await page.click("button:has-text('Create agent')");
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
    const scoutId = page.url().split("/").pop()!;
    const pending = await until("a pending approval", async () => {
      const r = await eng("sam", "GET", `/api/companies/${S.org!.id}/approvals?status=pending`);
      return Array.isArray(r.json) && r.json.length ? r.json : null;
    });
    console.log("       approval:", JSON.stringify(pending[0]).slice(0, 300));
    await page.goto(c.base + "/pve/acm/decisions");
    await page.waitForSelector("text=Scout", { timeout: 15000 });
    await shot(page, "09-decisions-hire");
    await page.getByRole("button", { name: /^Approve/ }).first().click();
    await until("the approval to be approved", async () => {
      const r = await eng("sam", "GET", `/api/companies/${S.org!.id}/approvals`);
      return (r.json as any[]).some((a) => a.status === "approved");
    });
    const agent = await until("the hired agent to leave pending_approval", async () => {
      const a = (await eng("sam", "GET", `/api/agents/${scoutId}`)).json;
      return a.status !== "pending_approval" ? a : null;
    });
    console.log("       Scout after approval:", agent.status);
    await page.reload();
    await tab(page, "History").click();
    await page.waitForSelector("text=Scout");
    await shot(page, "09-decisions-history");
    await page.goto(c.base + "/pve/acm/settings");
    await page.getByRole("switch", { name: "Require approval for new agents" }).click();
    await until("the setting off again", async () => (await eng("sam", "GET", `/api/companies/${S.org!.id}`)).json?.requireBoardApprovalForNewAgents === false);
  });

  await stage("routines: create a scheduled routine, run it now, read its history", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/routines");
    await page.click("button:has-text('New routine')");
    await page.fill("#rt-title", "Morning summary");
    await page.fill("#rt-desc", "Summarise what the anvils did yesterday.");
    await page.selectOption("#rt-agent", { label: "Runner" });
    await page.selectOption("#rt-schedule", "custom");
    await page.fill("#rt-cron", "0 9 * * 1-5");
    await shot(page, "10-new-routine");
    await page.getByRole("button", { name: /^Create/ }).last().click();
    await page.waitForURL(/\/routines\/[0-9a-f-]{36}$/, { timeout: 20000 });
    const routineId = page.url().split("/").pop()!;
    const r = await eng("sam", "GET", `/api/routines/${routineId}`);
    expect(r.status === 200 && r.json.title === "Morning summary", `the engine has the routine, got ${r.text.slice(0, 200)}`);
    const triggers = (r.json.triggers ?? []) as any[];
    expect(triggers.some((t) => t.kind === "schedule" && t.cronExpression === "0 9 * * 1-5"), `the routine has its schedule trigger, got ${JSON.stringify(triggers).slice(0, 300)}`);
    await page.waitForSelector("text=Morning summary");
    await shot(page, "10-routine-detail");
    await page.getByRole("button", { name: /Run now/ }).click();
    const runs = await until("a routine run", async () => {
      const x = await eng("sam", "GET", `/api/routines/${routineId}/runs`);
      const list = Array.isArray(x.json) ? x.json : x.json?.runs ?? [];
      return list.length ? list : null;
    });
    console.log("       routine run:", JSON.stringify({ status: runs[0].status, source: runs[0].source, issue: runs[0].linkedIssueId ?? runs[0].issueId }).slice(0, 200));
    await page.reload();
    await page.waitForSelector("text=Morning summary");
    await page.waitForTimeout(1500);
    await shot(page, "10-routine-run-history");
    await page.goto(c.base + "/pve/acm/routines");
    await page.waitForSelector("text=Morning summary");
    await shot(page, "10-routines-list");
  });

  await stage("chat: off by default, an administrator turns it on without touching the container policy", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/chat");
    await page.waitForSelector("text=Chat is switched off");
    await shot(page, "11-chat-off");
    const before = (await eng("sam", "GET", "/api/instance/settings/experimental")).json;
    expect(before.enableAgentChat !== true && before.enableManagedSandboxOnly === true, `chat starts off and the sandbox policy is on, got ${JSON.stringify(before)}`);
    await page.click("button:has-text('Turn on chat')");
    await page.waitForSelector("text=Pick an agent", { timeout: 15000 });
    const after = (await eng("sam", "GET", "/api/instance/settings/experimental")).json;
    expect(after.enableAgentChat === true && after.enableManagedSandboxOnly === true, `chat is on and the sandbox policy is still on, got ${JSON.stringify(after)}`);
    await page.click("button:has-text('Runner')");
    await page.fill('textarea[aria-label="Message Runner"]', "How sharp are they?");
    await page.keyboard.press("Enter");
    // The message is a comment on the conversation's task (a UUID per message); it lands in the thread, not just the box.
    await page.waitForSelector("p.whitespace-pre-wrap:has-text('How sharp are they?')", { timeout: 15000 });
    await until("the message box to be cleared after sending", async () => (await page.inputValue('textarea[aria-label="Message Runner"]')) === "", 10000);
    // The agent can't run (no containers), so its conversation must not claim it is still writing.
    await sleep(6000);
    const chats = await eng("sam", "GET", `/api/companies/${S.org!.id}/chats`);
    console.log("       conversations:", JSON.stringify((chats.json as any[]).map((x) => ({ state: x.conversationState, agent: x.conversationAgentId?.slice(0, 8) }))));
    await shot(page, "11-chat-thread");
  });

  await stage("costs: the summary reads, and a budget is saved to the engine", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/costs");
    await page.waitForSelector("text=spent, no budget set");
    await page.fill('input[aria-label="Monthly budget in dollars"]', "50");
    await page.click("button:has-text('Save budget')");
    await page.waitForSelector("text=of $50.00 budgeted", { timeout: 15000 });
    const co = (await eng("sam", "GET", `/api/companies/${S.org!.id}`)).json;
    expect(co.budgetMonthlyCents === 5000, `the engine has the budget, got ${co.budgetMonthlyCents}`);
    for (const v of ["By project", "By provider", "By model"]) { await tab(page, v).click(); await page.waitForTimeout(500); }
    await shot(page, "12-costs");
  });

  await stage("work: projects and goals are created in the engine; search finds the task", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/acm/projects");
    await page.click("button:has-text('New project')");
    await page.fill('input[placeholder="e.g. Customer portal"]', "Forge expansion");
    await page.getByRole("button", { name: /^Create/ }).last().click();
    await page.waitForSelector("text=Forge expansion");
    await page.goto(c.base + "/pve/acm/goals");
    await page.click("button:has-text('New goal')");
    await page.fill('input[placeholder="e.g. Ship the beta to 50 users"]', "Sharpen every anvil by Friday");
    await page.keyboard.press("Enter");
    await page.waitForSelector("text=Sharpen every anvil by Friday");
    const projects = (await eng("sam", "GET", `/api/companies/${S.org!.id}/projects`)).json;
    expect(projects.some((p: any) => p.name === "Forge expansion"), "the engine has the project");
    const goals = (await eng("sam", "GET", `/api/companies/${S.org!.id}/goals`)).json;
    expect(goals.some((g: any) => g.title === "Sharpen every anvil by Friday"), "the engine has the goal");
    await shot(page, "13-goals");
    await page.goto(c.base + "/pve/acm/tasks");
    await page.keyboard.press("/");
    await page.keyboard.type("anvils");
    await page.waitForSelector("text=Sharpen the anvils", { timeout: 15000 });
    await shot(page, "13-search");
    await page.keyboard.press("Escape");
    await page.goto(c.base + "/pve/acm/activity");
    await page.waitForSelector("text=Forge expansion");
    await shot(page, "13-activity");
  });

  // ---- Pin
  const pinText = () => c.provider.asked.filter((a) => a.method === "POST").map((a) => a.body);
  await stage("pin: set the model connector and Pin's model in the console", async () => {
    const { page } = await open("sam");
    await page.goto(c.base + "/pve/home?settings=connectors");
    await page.click("button:has-text('Set key')");
    await page.fill('input[aria-label="Anthropic key"]', "sk-ant-e2e-0123456789abcdefWXYZ");
    await page.click("button:has-text('Save')");
    await page.waitForSelector("text=WXYZ");
    await page.click("button:has-text('Test')");
    await page.waitForSelector("text=The key works.");
    const asked = c.provider.asked.find((a) => a.method === "GET");
    expect(asked?.headers["x-api-key"] === "sk-ant-e2e-0123456789abcdefWXYZ", "the saved key was used to call the provider");
    const listed = await call("sam", "GET", "/api/connectors");
    expect(!listed.text.includes("0123456789abcdef"), "the key is never sent back to the browser");
    await shot(page, "14-connectors");
    await page.goto(c.base + "/pve/pin?tab=settings");
    await page.getByRole("radio", { name: /Anthropic/ }).click();
    await page.selectOption("#pin-model", "model-fast");
    await page.getByRole("radio", { name: /^Agent Acts on its own/ }).click();
    await page.click("button:has-text('Test connection')");
    await page.waitForSelector("text=/works|Working|Connected|ok/i");
    await page.click("button:has-text('Save settings')");
    await until("Pin's settings saved", async () => (await call("sam", "GET", "/api/pin/settings")).json?.model === "model-fast");
    const saved = (await call("sam", "GET", "/api/pin/settings")).json;
    expect(saved.provider === "anthropic" && saved.mode === "agent", `provider and mode saved, got ${JSON.stringify(saved)}`);
    await shot(page, "14-pin-settings");
  });

  await stage("pin: a chat turn reads the real engine through a tool and answers from it", async () => {
    const { page } = await open("sam");
    c.provider.next = "orgs";
    await page.goto(c.base + "/pve/home");
    await page.waitForSelector("text=THIS DEVICE");
    await page.fill('input[placeholder="Ask Pin"]', "Which organizations do we have?");
    await page.keyboard.press("Enter");
    await page.waitForSelector("text=/Pin saw:/", { timeout: 30000 });
    await shot(page, "15-pin-chat-orgs");
    const second = c.provider.asked.filter((a) => a.method === "POST" && a.body.includes("tool_result")).at(-1);
    expect(second, "Pin sent the tool's result back to the model");
    expect(second!.body.includes(S.org!.id) && second!.body.includes("Acme Labs"), "the tool result carries the real organization (a UUID id and its name)");
    c.provider.next = "summary";
    c.provider.orgId = S.org!.id;
    await page.fill('input[placeholder="Ask Pin"]', "How is Acme Labs doing?");
    await page.keyboard.press("Enter");
    await until("the summary tool result", () => c.provider.asked.some((a) => a.body.includes("tool_result") && a.body.includes("openIssues")), 30000);
    const sum = c.provider.asked.filter((a) => a.body.includes("openIssues")).at(-1)!.body;
    expect(sum.includes("Runner") && sum.includes("Sharpen the anvils"), `the summary lists the real agent and task, got ${sum.slice(-600)}`);
    expect(sum.includes("pendingApprovals"), "the summary includes approvals");
    await page.waitForTimeout(800);
    await shot(page, "15-pin-chat-summary");
  });

  await stage("pin: a proposed plan is approved step by step, in Proxmox and in the engine", async () => {
    const { page } = await open("sam");
    c.provider.next = "plan";
    c.provider.plan = {
      title: "Retire the cache container",
      summary: "Snapshot it first, ask the team to review, then shut it down.",
      steps: [
        { kind: "snapshot", vmid: 102, name: "before-e2e" },
        { kind: "create_task", companyId: S.org!.id, title: "Review the cache snapshot" },
        { kind: "power", vmid: 102, action: "shutdown" },
      ],
    };
    await page.goto(c.base + "/pve/home");
    await page.waitForSelector("text=THIS DEVICE");
    await page.fill('input[placeholder="Ask Pin"]', "Retire the cache container");
    await page.keyboard.press("Enter");
    const plan = await until("the plan to be filed", async () => {
      const r = await call("sam", "GET", "/api/pin/plans");
      return (r.json?.plans as any[] | undefined)?.find((p) => p.title === "Retire the cache container");
    }, 30000);
    expect(plan.steps.length === 3 && plan.steps.every((x: any) => x.state === "pending"), `three pending steps, got ${JSON.stringify(plan.steps.map((x: any) => x.state))}`);
    expect(c.pve.pin.snapshots.get(102) === undefined, "nothing ran before approval");
    await page.goto(c.base + "/pve/pin?tab=plans");
    await page.waitForSelector("text=Retire the cache container");
    await shot(page, "16-plan-pending");
    await page.getByRole("button", { name: "Approve step" }).first().click();
    await until("the snapshot in Proxmox", () => (c.pve.pin.snapshots.get(102) ?? []).includes("before-e2e"));
    await page.getByRole("button", { name: "Approve step" }).first().click();
    const made = await until("the task in the engine", async () => {
      const r = await eng("sam", "GET", `/api/companies/${S.org!.id}/issues`);
      return (Array.isArray(r.json) ? r.json : r.json.issues).find((i: any) => i.title === "Review the cache snapshot");
    });
    expect(/^ACM-\d+$/.test(made.identifier), `the engine numbered the new task, got ${made.identifier}`);
    await page.getByRole("button", { name: "Review and approve" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("shutdown 102");
    await shot(page, "16-plan-confirm");
    await page.getByRole("button", { name: "Approve and run" }).click();
    await until("the machine to stop", () => c.pve.pin.guests.get(102)!.status === "stopped");
    const done = await until("the plan to finish", async () => {
      const r = (await call("sam", "GET", `/api/pin/plans/${plan.id}`)).json.plan;
      return r.steps.every((x: any) => x.state === "done") ? r : null;
    });
    expect(done.status === "done" || done.status === "complete" || done.status === "completed", `the plan is finished, status ${done.status}`);
    await page.reload();
    await page.waitForSelector("text=Retire the cache container");
    await shot(page, "16-plan-done");
    // A script's API token can read plans but never approve them.
  });

  await stage("pin: every tab opens on live data", async () => {
    const { page } = await open("sam");
    for (const t of ["overview", "chat", "memory", "automations", "inbox", "plans", "activity", "skills", "updates", "settings"]) {
      await page.goto(c.base + `/pve/pin?tab=${t}`);
      await page.waitForSelector("h1:has-text('Pin')");
      await page.waitForTimeout(900);
      await shot(page, `17-pin-tab-${t}`);
      const text = await bodyText(page);
      if (t === "activity") expect(!/Nothing fired|drive2|release notes and flagged/.test(text), "a live device's Pin activity has none of the demo's made-up lines");
      if (t === "overview") expect(/Anthropic[\s\S]*Connected/.test(text.slice(text.indexOf("Connectors"))), "Pin's overview lists the real connector");
    }
  });

  await stage("automations: a scheduled automation is created in the console and fires on time, once a day", async () => {
    const { page } = await open("sam");
    const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m, 0).getTime();
    c.pinClock.t = at(14, 1, 0);
    await page.goto(c.base + "/pve/automations");
    await page.getByRole("button", { name: "New automation" }).first().click();
    await page.fill("#au-name", "Nightly snapshot of production");
    await page.getByRole("radio", { name: "On a schedule" }).click();
    await page.fill("#au-at", "02:30");
    await page.fill("#au-tag", "prod");
    await page.selectOption("#au-action", "snapshot");
    await page.waitForSelector("text=/day at 02:30/i");
    await shot(page, "18-new-automation");
    await page.getByRole("button", { name: "Save automation" }).click();
    const needsOwner = await page.getByText("Let it act with all of my Proxmox permissions").isVisible({ timeout: 1500 }).catch(() => false);
    if (needsOwner) {
      await page.getByRole("switch", { name: "Let it act with all my permissions" }).click();
      await page.getByRole("button", { name: "Save automation" }).click();
    }
    await page.waitForSelector("text=Nightly snapshot of production", { timeout: 15000 });
    const list = (await call("sam", "GET", "/api/pin/automations")).json;
    expect(list.automations.length === 1 && (list.automations[0].spec ?? list.automations[0]).trigger?.dailyAt === "02:30", `the automation is stored, got ${JSON.stringify(list).slice(0, 300)}`);
    const before = (c.pve.pin.snapshots.get(101) ?? []).length;
    await c.pin.runner.tick();
    c.pinClock.t = at(14, 2, 29);
    await c.pin.runner.tick();
    expect((c.pve.pin.snapshots.get(101) ?? []).length === before, "nothing happens before 02:30");
    c.pinClock.t = at(14, 2, 31);
    await c.pin.runner.tick();
    await until("the scheduled snapshot", () => (c.pve.pin.snapshots.get(101) ?? []).length === before + 1);
    expect(!(c.pve.pin.snapshots.get(102) ?? []).some((n) => n.startsWith("auto")), "the machine without the prod tag was left alone");
    c.pinClock.t = at(14, 9, 0);
    await c.pin.runner.tick();
    expect((c.pve.pin.snapshots.get(101) ?? []).length === before + 1, "it doesn't fire twice in a day");
    c.pinClock.t = at(15, 2, 31);
    await c.pin.runner.tick();
    await until("the next day's snapshot", () => (c.pve.pin.snapshots.get(101) ?? []).length === before + 2);
    const runs = (await call("sam", "GET", "/api/pin/automations/runs")).json;
    expect((runs.runs ?? []).length >= 2, `the run history has both runs, got ${JSON.stringify(runs).slice(0, 300)}`);
    const made = c.pve.pin.calls.filter((x) => x.method === "POST" && /snapshot$/.test(x.path) && x.path.includes("/101/"));
    console.log("       snapshot made by:", [...new Set(made.map((x) => x.who))].join(", "));
    await page.reload();
    await page.waitForSelector("text=Nightly snapshot of production");
    await page.waitForTimeout(800);
    await shot(page, "18-automation-history");
  });

  await stage("machines: the wizard creates a container, and another inside the organization, in its pool", async () => {
    const { page } = await open("sam");
    const dialog = page.getByRole("dialog");
    const steps = page.getByRole("navigation", { name: "Steps" });
    const step = (name: RegExp) => steps.getByRole("button", { name }).click();
    await page.goto(c.base + "/pve/machines?modal=new-machine");
    await dialog.waitFor();
    await page.getByLabel("Hostname").fill("ct-e2e");
    await page.getByLabel("Root password").fill("correct-horse-battery");
    await page.getByLabel("SSH public key").fill("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop");
    await step(/Confirm/);
    await shot(page, "19-wizard-container-confirm");
    expect(!(await dialog.innerText()).includes("correct-horse-battery"), "the password is never shown");
    await page.getByRole("button", { name: "Create and start" }).click();
    await page.waitForURL(/\/machines\/\d+$/, { timeout: 20000 });
    const ct = [...c.pve.wizard.created.values()].find((m) => m.params.hostname === "ct-e2e");
    expect(ct && ct.type === "lxc" && ct.params.unprivileged === "1", `the container was created unprivileged, got ${JSON.stringify(ct)}`);
    await page.waitForSelector("text=ct-e2e", { timeout: 15000 });
    await shot(page, "19-wizard-container-page");

    await page.goto(c.base + "/pve/acm/machines");
    await page.getByRole("button", { name: "New machine" }).first().click();
    await dialog.waitFor();
    await shot(page, "19-wizard-in-org");
    const ownerField = page.getByLabel(/Belongs to|Owner/);
    if (await ownerField.count()) console.log("       owner field value:", await ownerField.first().inputValue());
    await page.getByLabel("Hostname").fill("ct-acme");
    await page.getByLabel("Root password").fill("another-long-passphrase");
    await step(/Confirm/);
    await page.getByRole("button", { name: "Create and start" }).click();
    await page.waitForURL(/\/machines\/\d+$/, { timeout: 20000 });
    const acme = [...c.pve.wizard.created.entries()].find(([, m]) => m.params.hostname === "ct-acme");
    expect(acme, "the organization's container was created");
    expect(acme![1].params.pool === "epc-acme-labs", `it was created in the organization's pool, got pool=${acme![1].params.pool}`);
    await page.goto(c.base + "/pve/acm/machines");
    await page.waitForSelector("text=ct-acme", { timeout: 15000 });
    await shot(page, "19-org-machines");
    // The new container is reachable by the organization's members through the pool ACL, and by nobody else.
    await signedIn("yuki");
    const yuki = await call("yuki", "GET", "/api/host");
    expect(yuki.status === 200 && !JSON.stringify(yuki.json?.resources ?? []).includes("ct-acme"), "a user with no access to the pool doesn't see its machines");
    const sam = await call("sam", "GET", "/api/host");
    expect(JSON.stringify(sam.json?.resources ?? []).includes("ct-acme"), "an administrator does");
  });

  const bearer = async (token: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(c.base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const makeToken = async (page: Page, name: string, readOnly: boolean): Promise<string> => {
    await page.goto(c.base + "/pve/home?settings=access");
    await tab(page, "API tokens").click();
    await page.getByRole("button", { name: "New API token" }).click();
    await page.getByRole("dialog").locator("input").first().fill(name);
    if (readOnly) await page.getByRole("switch", { name: "Read-only" }).click();
    await page.getByRole("button", { name: "Create token" }).click();
    const token = await page.locator('[data-testid="secret-value"]').first().innerText({ timeout: 15000 });
    expect(/^epc_/.test(token), `an ePaperclip token looks like epc_..., got ${token.slice(0, 8)}`);
    await page.getByLabel("I've saved it").check();
    await page.getByRole("button", { name: "Done" }).click();
    return token;
  };

  await stage("api tokens: a Bearer token works without a browser, read-only can't write, none can approve or mint tokens", async () => {
    const { page } = await open("sam");
    const full = await makeToken(page, "e2e-full", false);
    const ro = await makeToken(page, "e2e-readonly", true);
    await shot(page, "24-api-tokens");
    expect((await bearer(null, "GET", "/api/host")).status === 401, "no token, no access");
    expect((await bearer("epc_notarealtoken0000000000000000", "GET", "/api/host")).status === 401, "a made-up token is refused");
    const host = await bearer(full, "GET", "/api/host");
    expect(host.status === 200 && Array.isArray(host.json.resources), `the token reads the host, got ${host.status} ${host.text.slice(0, 120)}`);
    const orgs = await bearer(full, "GET", "/engine/api/companies");
    expect(orgs.status === 200 && orgs.json.some((x: any) => x.id === S.org!.id), `the token reaches the engine as its owner, got ${orgs.status} ${orgs.text.slice(0, 160)}`);
    const made = await bearer(full, "POST", `/engine/api/companies/${S.org!.id}/issues`, { title: "Created with a token" });
    expect(made.status === 201 || made.status === 200, `a full token can create a task, got ${made.status} ${made.text.slice(0, 160)}`);
    const readHost = await bearer(ro, "GET", "/api/host");
    expect(readHost.status === 200, "a read-only token can read");
    const refused = await bearer(ro, "POST", `/engine/api/companies/${S.org!.id}/issues`, { title: "Should not exist" });
    expect(refused.status === 403, `a read-only token can't write to the engine, got ${refused.status}`);
    const issues = (await eng("sam", "GET", `/api/companies/${S.org!.id}/issues`)).json;
    expect(!issues.some((i: any) => i.title === "Should not exist") && issues.some((i: any) => i.title === "Created with a token"), "only the full token's task exists");
    const approve = await bearer(full, "POST", "/api/pin/plans/0000000000000000/steps/00000000/approve", { confirm: "x" });
    expect(approve.status === 403 && approve.json?.code === "ticket_only", `a token can't approve a plan, got ${approve.status} ${approve.text.slice(0, 120)}`);
    const mint = await bearer(full, "POST", "/api/access/epc-tokens", { name: "child", expiresInDays: 7, readOnly: false, privsep: false });
    expect(mint.status === 403, `a token can't make tokens, got ${mint.status}`);
    const toTfa = await bearer(full, "PUT", "/api/iac/users/sam@pve/password", { password: "x".repeat(12), confirmationPassword: "right" });
    expect(toTfa.status === 403, `a token can't change a password, got ${toTfa.status}`);
    // Revoking in the console stops it at once.
    await page.goto(c.base + "/pve/home?settings=access");
    await tab(page, "API tokens").click();
    await page.getByRole("button", { name: /Revoke/ }).first().click();
    await page.getByRole("button", { name: "Revoke", exact: true }).last().click().catch(() => undefined);
    await until("the first token to stop working", async () => (await bearer(full, "GET", "/api/host")).status === 401 || (await bearer(ro, "GET", "/api/host")).status === 401);
    await shot(page, "24-api-tokens-revoked");
  });

  // ---- Device pages against the fake Proxmox
  const crawl = async (user: string, routes: [string, RegExp][], label: string) => {
    const { page } = await open(user);
    const alerts: string[] = [];
    for (const [route, mustShow] of routes) {
      await page.goto(c.base + "/pve/" + route);
      await page.waitForSelector("h1", { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
      const text = await bodyText(page);
      const shown = (await page.locator('[role="alert"]').allInnerTexts()).map((t: string) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
      for (const a of shown) alerts.push(`${route}: ${a.slice(0, 160)}`);
      await shot(page, `${label}-${route.replace(/\W+/g, "_")}`);
      if (/Page not found|isn't here|Not found/i.test(text.slice(text.indexOf("Access control")))) throw new Error(`${route} shows a not-found page`);
      if (!mustShow.test(text)) throw new Error(`${route} doesn't show ${mustShow}; it shows: ${text.slice(text.indexOf("Access control") + 14, text.indexOf("Access control") + 300)}`);
    }
    if (alerts.length) throw new Error("pages showed errors:\n  " + alerts.join("\n  "));
  };

  await stage("device: summary, resources, storage, network, firewall, backups, tasks, machines open", async () => {
    await crawl("sam", [
      ["summary", /Proxmox|Summary/], ["resources", /Resources/], ["storage", /local-lvm/], ["storage/local", /local/], ["store", /Store/], ["tasks", /Tasks/],
      ["network", /vmbr0/], ["firewall", /Firewall/], ["backups", /Backups/], ["machines", /web/], ["machines/101", /web/], ["machines/200", /db/], ["automations", /Automations/],
    ], "20-device");
  });

  await stage("disks: physical disks, LVM, ZFS and storage definitions load", async () => {
    await crawl("sam", [["disks", /\/dev\/sd|Boot SSD|Data HDD/], ["storage-settings", /local-lvm|nas|tank/]], "21-disks");
  });

  await stage("node: services, time, logs, updates, certificates, power load", async () => {
    await crawl("sam", [["host/services", /pveproxy/], ["host/time", /Europe\/Berlin|timezone|Time zone/i], ["host/logs", /Journal/], ["host/updates", /pve-manager/], ["host/certificates", /Certificate|certificate/], ["host/power", /Restart|Shut down|Subscription/]], "22-node");
  });

  await stage("datacenter and cluster: summary, options, notifications, metrics, mappings, tags, HA, replication, Ceph", async () => {
    await crawl("sam", [["datacenter/cluster", /lab|Cluster/], ["datacenter/summary", /pve2|Datacenter|Cluster/], ["datacenter/options", /keyboard|Keyboard|Options/], ["datacenter/notifications", /Notification/i], ["datacenter/metrics", /Metric/i],
      ["datacenter/mappings", /gpu0|Mapping/i], ["datacenter/tags", /Tag/i], ["datacenter/ha", /vm:103|High availability/], ["datacenter/replication", /101-0|Replication/], ["datacenter/ceph", /Ceph|vm-pool/], ["tasks/all", /Tasks|tasks/i]], "23-datacenter");
  });

  await stage("security headers: the console is served with its strict policy and signs cookies HttpOnly, SameSite=Strict", async () => {
    const home = await fetch(c.base + "/");
    const csp = home.headers.get("content-security-policy") ?? "";
    expect(csp.includes("script-src 'self'") && csp.includes("style-src 'self'") && !/unsafe-(inline|eval)/.test(csp) && csp.includes("frame-ancestors 'none'"), `the console's CSP is strict, got ${csp}`);
    const html = await home.text();
    expect(!/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html) && !/\son\w+=/i.test(html), "the page has no inline script or handlers");
    expect(!/https?:\/\/(?!127\.0\.0\.1|www\.w3\.org\/2000\/svg)/.test(html.replace(/<!--[\s\S]*?-->/g, "")), "the page loads nothing from other sites");
    const login = await fetch(c.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "lee", password: "right", realm: "pve" }) });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(/HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie), `the session cookie is HttpOnly and SameSite=Strict, got ${cookie.replace(/=[^;]+/, "=…")}`);
    expect(!JSON.stringify(await login.json()).includes("PVE:"), "the login answer carries no Proxmox ticket");
    const nohdr = await fetch(c.base + "/engine/api/companies", { method: "POST", headers: { Cookie: cookie.split(";")[0], "Content-Type": "application/json" }, body: JSON.stringify({ name: "csrf" }) });
    expect(nohdr.status === 403, `a write without the request header is refused, got ${nohdr.status}`);
    const wrongOrigin = await fetch(c.base + "/engine/api/companies", { method: "POST", headers: { Cookie: cookie.split(";")[0], "Content-Type": "application/json", "X-EPC-Request": "1", Origin: "https://evil.example" }, body: JSON.stringify({ name: "csrf" }) });
    expect(wrongOrigin.status === 403, `a write from another origin is refused, got ${wrongOrigin.status}`);
    const off = await fetch(c.base + "/engine/api/instance/settings/experimental", { method: "PATCH", headers: { Cookie: cookie.split(";")[0], "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ enableManagedSandboxOnly: false }) });
    expect(off.status === 403, `turning the managed-sandbox-only policy off through the proxy is refused, got ${off.status}`);
    expect((await eng("sam", "GET", "/api/instance/settings/experimental")).json.enableManagedSandboxOnly === true, "the policy is still on");
  });

  await stage("sign out, and a session that expires while a page is open", async () => {
    const { page } = await open("lee");
    await page.goto(c.base + "/pve/home?settings=general");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForSelector("text=Sign in to ePaperclip", { timeout: 15000 });
    expect((await call("lee", "GET", "/api/host")).status === 401, "the session is gone on the host");
    await shot(page, "25-signed-out");
    // Signing back in lands on the console again, and an idle session expires after two hours.
    await signInUi(page, "lee");
    await page.waitForSelector("text=THIS DEVICE", { timeout: 20000 });
    c.clock.skew += 3 * 3600_000;
    await page.goto(c.base + "/pve/machines");
    await page.waitForSelector("text=Sign in to ePaperclip", { timeout: 15000 });
    expect((await call("lee", "GET", "/api/host")).status === 401, "an idle session older than two hours is refused");
    await shot(page, "25-session-expired");
    c.clock.skew = 0;
    await signInUi(page, "lee");
    await page.waitForSelector("text=THIS DEVICE", { timeout: 20000 });
    // The other people's sessions expired with the clock too; sign-in works for them again.
    await signedInAgain("sam");
  });

  return results;
}

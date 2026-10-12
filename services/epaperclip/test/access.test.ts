import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAccessApp } from "./access-harness.ts";

let h: Awaited<ReturnType<typeof startAccessApp>>;
let sam: string;
let lee: string;
beforeEach(async () => {
  h = await startAccessApp();
  sam = await h.signIn("sam");
  lee = await h.signIn("lee");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

const j = async (r: Response) => (await r.json()) as any;
const get = async (path: string, cookie = sam) => j(await h.call("GET", path, { cookie }));

describe("groups", () => {
  it("lists, creates with members, edits, shows effective permissions and deletes", async () => {
    expect((await get("/api/access/groups")).groups).toEqual([{ groupid: "ops", comment: "Operations", members: [] }]);
    const c = await h.call("POST", "/api/access/groups", { cookie: sam }, { groupid: "dev", comment: "Developers", members: ["lee@pve", "kim@pve"] });
    expect(c.status).toBe(200);
    expect((await get("/api/access/groups")).groups.find((g: any) => g.groupid === "dev")).toMatchObject({ comment: "Developers", members: ["lee@pve", "kim@pve"] });
    expect((await h.call("PUT", "/api/access/groups/dev", { cookie: sam }, { comment: "Dev team", members: ["kim@pve"] })).status).toBe(200);
    const g = await get("/api/access/groups/dev");
    expect(g).toMatchObject({ comment: "Dev team", members: ["kim@pve"] });
    expect(h.pve.users.get("lee@pve")!.groups).toEqual([]);
    await h.call("POST", "/api/access/acl", { cookie: sam }, { path: "/vms", roles: ["PVEAuditor"], groups: ["dev"] });
    const eff = await get("/api/access/groups/dev/permissions");
    expect(eff.entries).toEqual([expect.objectContaining({ path: "/vms", roleid: "PVEAuditor", propagate: true, privileges: expect.arrayContaining(["VM.Audit"]) })]);
    expect((await h.call("DELETE", "/api/access/groups/dev", { cookie: sam })).status).toBe(200);
    expect(h.pve.groups.has("dev")).toBe(false);
  });

  it("validates names and members before anything reaches Proxmox", async () => {
    const before = h.pve.calls.length;
    for (const body of [{ groupid: "bad name" }, { groupid: "ok", members: ["nobody"] }, { groupid: "ok", comment: "a\nb" }]) {
      expect((await h.call("POST", "/api/access/groups", { cookie: sam }, body)).status).toBe(400);
    }
    expect(h.pve.calls.slice(before).filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("turns a Proxmox refusal into a clear message that names the missing privilege", async () => {
    const r = await h.call("POST", "/api/access/groups", { cookie: lee }, { groupid: "x" });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toMatch(/Proxmox refused: Permission check failed \(\/access\/groups, Group\.Allocate\)/);
  });

  it("needs a session and the page header", async () => {
    expect((await h.call("GET", "/api/access/groups")).status).toBe(401);
    expect((await fetch(h.base + "/api/access/groups", { method: "POST", headers: { Cookie: sam, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  });
});

describe("roles and permissions", () => {
  it("lists built-in and custom roles with privileges and descriptions", async () => {
    await h.call("POST", "/api/access/roles", { cookie: sam }, { roleid: "Backuper", privileges: ["VM.Audit", "VM.Backup"] });
    const r = await get("/api/access/roles");
    expect(r.roles.find((x: any) => x.roleid === "Administrator")).toMatchObject({ builtin: true });
    expect(r.roles.find((x: any) => x.roleid === "Backuper")).toEqual({ roleid: "Backuper", builtin: false, privileges: ["VM.Audit", "VM.Backup"] });
    expect(r.privileges.find((p: any) => p.name === "VM.Backup")).toMatchObject({ group: "Machines", description: expect.stringContaining("Back up") });
    expect(r.canManage).toBe(true);
  });

  it("every privilege Proxmox knows has a description, and unknown ones are refused", async () => {
    const known = (await get("/api/access/roles")).privileges.map((p: any) => p.name);
    const roles = await get("/api/access/roles");
    for (const p of roles.roles.find((x: any) => x.roleid === "Administrator").privileges) expect(known).toContain(p);
    const bad = await h.call("POST", "/api/access/roles", { cookie: sam }, { roleid: "Odd", privileges: ["VM.Audit", "Made.Up"] });
    expect(bad.status).toBe(400);
  });

  it("edits and deletes custom roles; built-ins are read-only", async () => {
    await h.call("POST", "/api/access/roles", { cookie: sam }, { roleid: "Backuper", privileges: ["VM.Audit"] });
    expect((await h.call("PUT", "/api/access/roles/Backuper", { cookie: sam }, { privileges: ["VM.Audit", "VM.Snapshot"] })).status).toBe(200);
    expect(h.pve.roles.get("Backuper")!.privs).toEqual(["VM.Audit", "VM.Snapshot"]);
    const builtin = await h.call("PUT", "/api/access/roles/PVEAuditor", { cookie: sam }, { privileges: ["VM.Audit"] });
    expect(builtin.status).toBe(400);
    expect((await j(builtin)).code).toBe("builtin_role");
    expect((await h.call("DELETE", "/api/access/roles/PVEAuditor", { cookie: sam })).status).toBe(400);
    await h.call("POST", "/api/access/acl", { cookie: sam }, { path: "/vms", roles: ["Backuper"], users: ["lee@pve"] });
    const inUse = await h.call("DELETE", "/api/access/roles/Backuper", { cookie: sam });
    expect(inUse.status).toBe(409);
    expect((await j(inUse)).code).toBe("role_in_use");
    const gone = await h.call("DELETE", "/api/access/roles/Backuper", { cookie: sam }, { removeAcls: true });
    expect(gone.status).toBe(200);
    expect(h.pve.roles.has("Backuper")).toBe(false);
    expect(h.pve.acl.some((a) => a.roleid === "Backuper")).toBe(false);
  });

  it("lists every ACL, marks the ones our device and organization roles make, and adds and removes any", async () => {
    h.state.setSetting("resourceGroups", { c1: { name: "Northwind", pool: "epc-northwind" } });
    h.pve.acl.push({ path: "/pool/epc-northwind", ugid: "lee@pve", type: "user", roleid: "PVEVMAdmin", propagate: 1 });
    const add = await h.call("POST", "/api/access/acl", { cookie: sam }, { path: "/storage/local", roles: ["PVEAuditor"], users: ["kim@pve"], propagate: false });
    expect(add.status).toBe(200);
    const r = await get("/api/access/acl");
    expect(r.canModify).toBe(true);
    expect(r.acls.find((a: any) => a.ugid === "sam@pve")).toMatchObject({ path: "/", roleid: "Administrator", preset: "Device role: admin" });
    expect(r.acls.find((a: any) => a.ugid === "lee@pve")).toMatchObject({ preset: "Organization role in Northwind" });
    expect(r.acls.find((a: any) => a.ugid === "kim@pve")).toMatchObject({ path: "/storage/local", propagate: false, preset: null });
    expect((await h.call("POST", "/api/access/acl", { cookie: sam }, { path: "/storage/local", roles: ["PVEAuditor"], users: ["kim@pve"], remove: true })).status).toBe(200);
    expect(h.pve.acl.some((a) => a.ugid === "kim@pve")).toBe(false);
  });

  it("validates ACL input and lets Proxmox refuse people without Permissions.Modify", async () => {
    for (const body of [{ path: "vms", roles: ["X1"], users: ["a@pve"] }, { path: "/vms/../x", roles: ["X1"], users: ["a@pve"] }, { path: "/vms", roles: [], users: ["a@pve"] }, { path: "/vms", roles: ["Role1"] }, { path: "/vms", roles: ["Role1"], tokens: ["nope"] }])
      expect((await h.call("POST", "/api/access/acl", { cookie: sam }, body)).status).toBe(400);
    const refused = await h.call("POST", "/api/access/acl", { cookie: lee }, { path: "/vms", roles: ["PVEAuditor"], users: ["lee@pve"] });
    expect(refused.status).toBe(403);
    expect((await j(refused)).error).toContain("Permissions.Modify");
  });

  it("shows the effective permissions of a user or token on a path", async () => {
    const r = await get("/api/access/permissions?userid=sam%40pve&path=/vms/101");
    expect(r.permissions["/vms/101"]["VM.Audit"]).toBe(1);
    expect((await h.call("GET", "/api/access/permissions?userid=bad", { cookie: sam })).status).toBe(400);
    expect((await h.call("GET", "/api/access/permissions?userid=sam%40pve&path=nope", { cookie: sam })).status).toBe(400);
  });

  it("offers paths to pick from machines, storage, devices, networks and pools", async () => {
    const { paths } = await get("/api/access/paths");
    const have = paths.map((p: any) => p.path);
    expect(have).toEqual(expect.arrayContaining(["/", "/vms", "/vms/101", "/vms/200", "/storage/local", "/nodes/pve", "/sdn/zones/zone1", "/pool/existing"]));
  });
});

describe("Proxmox API tokens", () => {
  it("creates a token and returns its secret once; listing never shows it", async () => {
    const c = await h.call("POST", "/api/access/users/lee%40pve/tokens", { cookie: sam }, { tokenid: "ci", comment: "CI", privsep: true });
    expect(c.status).toBe(201);
    const made = await j(c);
    expect(made.fullTokenid).toBe("lee@pve!ci");
    expect(made.value).toMatch(/-/);
    const list = await get("/api/access/users/lee%40pve/tokens");
    expect(JSON.stringify(list)).not.toContain(made.value);
    expect(list.tokens).toEqual([expect.objectContaining({ tokenid: "ci", privsep: true, epaperclip: null })]);
  });

  it("edits, regenerates and deletes; refuses the reserved prefix and bad names", async () => {
    await h.call("POST", "/api/access/users/lee%40pve/tokens", { cookie: sam }, { tokenid: "ci" });
    expect((await h.call("PUT", "/api/access/users/lee%40pve/tokens/ci", { cookie: sam }, { comment: "new", privsep: false })).status).toBe(200);
    expect(h.pve.tokens.get("lee@pve")!.get("ci")).toMatchObject({ comment: "new", privsep: 0 });
    const re = await j(await h.call("PUT", "/api/access/users/lee%40pve/tokens/ci", { cookie: sam }, { regenerate: true }));
    expect(re.value).toBe(h.pve.tokens.get("lee@pve")!.get("ci")!.secret);
    expect((await h.call("DELETE", "/api/access/users/lee%40pve/tokens/ci", { cookie: sam })).status).toBe(200);
    for (const tokenid of ["epc-123", "9bad", "a b"]) expect((await h.call("POST", "/api/access/users/lee%40pve/tokens", { cookie: sam }, { tokenid })).status).toBe(400);
  });

  it("never writes a token value to the log or the audit trail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const made = await j(await h.call("POST", "/api/access/users/lee%40pve/tokens", { cookie: sam }, { tokenid: "ci" }));
    const audit = await get("/api/access/audit");
    expect(JSON.stringify(audit)).not.toContain(made.value);
    expect(audit.entries[0]).toMatchObject({ action: "pve-token.create", actor: "sam@pve", target: "lee@pve!ci" });
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(made.value);
  });

  it("per-token permissions are ACLs for the full token id", async () => {
    await h.call("POST", "/api/access/users/lee%40pve/tokens", { cookie: sam }, { tokenid: "ci" });
    expect((await h.call("POST", "/api/access/acl", { cookie: sam }, { path: "/vms", roles: ["PVEAuditor"], tokens: ["lee@pve!ci"] })).status).toBe(200);
    expect(h.pve.acl).toContainEqual(expect.objectContaining({ ugid: "lee@pve!ci", type: "token", roleid: "PVEAuditor" }));
  });
});

describe("two-factor", () => {
  const uri = "otpauth://totp/PVE:kim%40pve?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&period=30&digits=6&algorithm=SHA1&issuer=PVE";
  it("adds an authenticator after Proxmox verifies the current code, and lists and deletes entries", async () => {
    const kim = await h.signIn("kim");
    const ok = await h.call("POST", "/api/access/tfa/kim%40pve", { cookie: kim }, { type: "totp", totp: uri, value: "123456", description: "Phone", password: "right" });
    expect(ok.status).toBe(200);
    const list = await get("/api/access/tfa/kim%40pve", kim);
    expect(list.entries).toEqual([expect.objectContaining({ type: "totp", description: "Phone", enabled: true })]);
    expect(JSON.stringify(list)).not.toContain("JBSWY3");
    const wrong = await h.call("POST", "/api/access/tfa/kim%40pve", { cookie: kim }, { type: "totp", totp: uri, value: "000000", password: "right" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await j(wrong)).error).toMatch(/verify TOTP/);
    const id = list.entries[0].id;
    expect((await h.call("PUT", `/api/access/tfa/kim%40pve/${id}`, { cookie: kim }, { enable: false, password: "right" })).status).toBe(200);
    expect((await get("/api/access/tfa/kim%40pve", kim)).entries[0].enabled).toBe(false);
    expect((await h.call("DELETE", `/api/access/tfa/kim%40pve/${id}`, { cookie: kim }, { password: "right" })).status).toBe(200);
    expect((await get("/api/access/tfa/kim%40pve", kim)).entries).toEqual([]);
  });

  it("returns recovery keys in the response only", async () => {
    const kim = await h.signIn("kim");
    const r = await j(await h.call("POST", "/api/access/tfa/kim%40pve", { cookie: kim }, { type: "recovery", password: "right" }));
    expect(r.recovery).toHaveLength(3);
    expect(JSON.stringify(await get("/api/access/tfa/kim%40pve", kim))).not.toContain("1111-2222");
    expect(JSON.stringify(await get("/api/access/audit"))).not.toContain("1111-2222");
  });

  it("lets an administrator see and remove another person's entries, and refuses others", async () => {
    const kim = await h.signIn("kim");
    await h.call("POST", "/api/access/tfa/kim%40pve", { cookie: kim }, { type: "recovery", password: "right" });
    const seen = await get("/api/access/tfa/kim%40pve");
    expect(seen.entries).toHaveLength(1);
    expect((await get("/api/access/tfa")).users).toEqual([expect.objectContaining({ userid: "kim@pve" })]);
    expect((await h.call("GET", "/api/access/tfa/kim%40pve", { cookie: lee })).status).toBe(403);
    expect((await h.call("DELETE", `/api/access/tfa/kim%40pve/${seen.entries[0].id}`, { cookie: sam })).status).toBe(200);
  });

  it("validates the authenticator link and code, and says WebAuthn lives in Proxmox", async () => {
    for (const body of [{ type: "totp", totp: "http://x", value: "123456" }, { type: "totp", totp: uri, value: "12" }, { type: "totp", totp: "otpauth://totp/x?secret=abc", value: "123456" }, { type: "webauthn" }])
      expect((await h.call("POST", "/api/access/tfa/sam%40pve", { cookie: sam }, body)).status).toBe(400);
  });

  it("refuses API-token callers for changes, as Proxmox does", async () => {
    const t = await j(await h.call("POST", "/api/access/epc-tokens", { cookie: sam }, { name: "robot" }));
    const r = await h.call("POST", "/api/access/tfa/sam%40pve", { bearer: t.token }, { type: "recovery" });
    expect(r.status).toBe(403);
    expect((await j(r)).code).toBe("ticket_only");
  });

  it("warns WebAuthn-only accounts at sign-in instead of asking for a code they can't give", async () => {
    h.pve.needTfa.set("yuki@pve", "webauthn");
    const r = await fetch(h.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "yuki", password: "right", realm: "pve" }) });
    expect(r.status).toBe(403);
    const b = await j(r);
    expect(b.code).toBe("tfa_webauthn_only");
    expect(b.error).toMatch(/security key/);
  });

  it("still asks for a code from accounts with an authenticator or recovery keys", async () => {
    h.pve.needTfa.set("kim@pve", "totp");
    const r = await fetch(h.base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "kim", password: "right", realm: "pve" }) });
    const b = await j(r);
    expect(b.needTfa).toBe(true);
    const done = await fetch(h.base + "/api/login/tfa", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ challenge: b.challenge, kind: "totp", code: "123456" }) });
    expect(done.status).toBe(200);
  });
});

describe("realms", () => {
  const ldap = { realm: "corp", type: "ldap", server1: "ldap.example.com", base_dn: "dc=example,dc=com", user_attr: "uid", bind_dn: "cn=svc,dc=example,dc=com", password: "bind-secret-1", mode: "ldaps", verify: true, comment: "Corp" };

  it("lists realms with their form schema and never returns bind passwords or client secrets", async () => {
    await h.call("POST", "/api/access/realms", { cookie: sam }, ldap);
    const r = await get("/api/access/realms");
    const corp = r.realms.find((x: any) => x.realm === "corp");
    expect(corp).toMatchObject({ type: "ldap", canSync: true, config: expect.objectContaining({ server1: "ldap.example.com" }) });
    expect(JSON.stringify(r)).not.toMatch(/bind-secret-1|SHOULD-NEVER-LEAK/);
    expect(r.schema.ldap.find((f: any) => f.name === "password")).toMatchObject({ secret: true, kind: "secret" });
    expect(r.creatable).toEqual(["ldap", "ad", "openid"]);
  });

  it("creates LDAP, Active Directory and OpenID realms, sending secrets to Proxmox only", async () => {
    expect((await h.call("POST", "/api/access/realms", { cookie: sam }, ldap)).status).toBe(200);
    expect((await h.call("POST", "/api/access/realms", { cookie: sam }, { realm: "ad1", type: "ad", server1: "dc.example.com", domain: "example.com" })).status).toBe(200);
    expect((await h.call("POST", "/api/access/realms", { cookie: sam }, { realm: "sso", type: "openid", "issuer-url": "https://id.example.com", "client-id": "epc", "client-key": "client-secret-9", autocreate: true })).status).toBe(200);
    expect(h.pve.realms.get("sso")).toMatchObject({ "client-key": "client-secret-9", autocreate: "1" });
    const log = JSON.stringify(h.state.getSetting("audit"));
    expect(log).not.toMatch(/bind-secret-1|client-secret-9/);
  });

  it("validates forms against the schema", async () => {
    const cases: Record<string, unknown>[] = [
      { realm: "x", type: "ldap", server1: "h" }, // base_dn and user_attr missing
      { ...ldap, mode: "plain" },
      { ...ldap, port: 99999 },
      { ...ldap, server1: "bad host!" },
      { ...ldap, verify: "yes" },
      { ...ldap, surprise: 1 },
      { ...ldap, realm: "1bad" },
      { ...ldap, type: "pam" },
      { realm: "o", type: "openid", "issuer-url": "http://insecure", "client-id": "x" },
      { ...ldap, tfa: "type=bogus" },
    ];
    for (const c of cases) expect((await h.call("POST", "/api/access/realms", { cookie: sam }, c)).status, JSON.stringify(c)).toBe(400);
  });

  it("checks the connection first when asked, and Proxmox's refusal comes through", async () => {
    const r = await h.call("POST", "/api/access/realms", { cookie: sam }, { ...ldap, realm: "down", server1: "down.example.com", "check-connection": true });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await j(r))).toMatch(/unable to connect/);
    expect(h.pve.realms.has("down")).toBe(false);
  });

  it("edits settings (TFA enforcement, default), keeps the old bind password when left blank, clears settings", async () => {
    await h.call("POST", "/api/access/realms", { cookie: sam }, ldap);
    expect((await h.call("PUT", "/api/access/realms/corp", { cookie: sam }, { tfa: "type=oath", comment: "Corporate", clear: ["bind_dn"] })).status).toBe(200);
    const cfg = h.pve.realms.get("corp")!;
    expect(cfg).toMatchObject({ tfa: "type=oath", comment: "Corporate", password: "bind-secret-1" });
    expect(cfg.bind_dn).toBeUndefined();
    expect((await get("/api/access/realms")).realms.find((x: any) => x.realm === "corp").tfa).toBe("type=oath");
    expect((await h.call("PUT", "/api/access/realms/pve", { cookie: sam }, { tfa: "type=oath", default: true })).status).toBe(200);
    expect((await h.call("PUT", "/api/access/realms/corp", { cookie: sam }, { clear: ["server1"] })).status).toBe(400);
  });

  it("deletes custom realms only", async () => {
    await h.call("POST", "/api/access/realms", { cookie: sam }, ldap);
    expect((await h.call("DELETE", "/api/access/realms/corp", { cookie: sam })).status).toBe(200);
    expect((await h.call("DELETE", "/api/access/realms/pam", { cookie: sam })).status).toBe(400);
    expect((await h.call("DELETE", "/api/access/realms/pve", { cookie: sam })).status).toBe(400);
  });

  it("syncs LDAP and AD realms as a task, a dry run by default, and the log is readable", async () => {
    await h.call("POST", "/api/access/realms", { cookie: sam }, ldap);
    const dry = await j(await h.call("POST", "/api/access/realms/corp/sync", { cookie: sam }, {}));
    expect(dry.dryRun).toBe(true);
    expect(dry.task).toMatch(/^UPID:pve:/);
    expect(h.pve.calls.filter((c) => c.path === "/access/domains/corp/sync").at(-1)!.body).toContain("dry-run=1");
    const log = await get(`/api/tasks/${encodeURIComponent(dry.task)}`);
    expect(log).toMatchObject({ exitstatus: "OK", log: ["would create user ann@corp", "TASK OK"] });
    const real = await j(await h.call("POST", "/api/access/realms/corp/sync", { cookie: sam }, { dryRun: false, scope: "users", removeVanished: ["acl", "entry"] }));
    expect(real.dryRun).toBe(false);
    expect(h.pve.calls.filter((c) => c.path === "/access/domains/corp/sync").at(-1)!.body).toContain("remove-vanished=acl%3Bentry");
    expect((await h.call("POST", "/api/access/realms/pam/sync", { cookie: sam }, {})).status).toBe(400);
    expect((await h.call("POST", "/api/access/realms/corp/sync", { cookie: sam }, { scope: "everything" })).status).toBe(400);
  });

  it("refuses realm changes from people without Realm.Allocate with Proxmox's reason", async () => {
    const r = await h.call("POST", "/api/access/realms", { cookie: lee }, ldap);
    expect(r.status).toBe(403);
    expect((await j(r)).error).toContain("Realm.Allocate");
  });
});

describe("pools", () => {
  it("creates, edits comment and members, and deletes a pool", async () => {
    expect((await h.call("POST", "/api/access/pools", { cookie: sam }, { poolid: "team", comment: "Team" })).status).toBe(200);
    expect((await h.call("PUT", "/api/access/pools/team", { cookie: sam }, { comment: "The team", addVms: ["101", "200"], addStorage: ["local"] })).status).toBe(200);
    const t = (await get("/api/access/pools")).pools.find((p: any) => p.poolid === "team");
    expect(t.comment).toBe("The team");
    expect(t.members).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "machine", id: "101", name: "web" }), expect.objectContaining({ kind: "storage", id: "local" })]));
    const full = await get("/api/access/pools");
    expect(full.candidates.machines.map((m: any) => m.vmid)).toEqual([101, 200]);
    expect(full.candidates.storage).toEqual(["local"]);
    expect((await h.call("DELETE", "/api/access/pools/team", { cookie: sam })).status).toBeGreaterThanOrEqual(400); // not empty
    await h.call("PUT", "/api/access/pools/team", { cookie: sam }, { removeVms: ["101", "200"], removeStorage: ["local"] });
    expect((await h.call("DELETE", "/api/access/pools/team", { cookie: sam })).status).toBe(200);
  });

  it("marks organization pools and refuses deleting one that is mapped to an organization", async () => {
    await h.call("POST", "/api/access/pools", { cookie: sam }, { poolid: "epc-northwind" });
    await h.call("POST", "/api/access/pools", { cookie: sam }, { poolid: "epc-orphan" });
    h.state.setSetting("resourceGroups", { c1: { name: "Northwind", pool: "epc-northwind" } });
    const pools = (await get("/api/access/pools")).pools;
    expect(pools.find((p: any) => p.poolid === "epc-northwind")).toMatchObject({ orgPool: true, organization: { companyId: "c1", name: "Northwind" } });
    expect(pools.find((p: any) => p.poolid === "epc-orphan")).toMatchObject({ orgPool: true, organization: null });
    const refused = await h.call("DELETE", "/api/access/pools/epc-northwind", { cookie: sam });
    expect(refused.status).toBe(409);
    expect((await j(refused)).code).toBe("organization_pool");
    expect(h.pve.pools.has("epc-northwind")).toBe(true);
    expect((await h.call("DELETE", "/api/access/pools/epc-orphan", { cookie: sam })).status).toBe(200);
  });

  it("validates ids and member lists, and Proxmox decides who may manage pools", async () => {
    for (const body of [{ poolid: "1x" }, { poolid: "a b" }]) expect((await h.call("POST", "/api/access/pools", { cookie: sam }, body)).status).toBe(400);
    expect((await h.call("PUT", "/api/access/pools/existing", { cookie: sam }, { addVms: ["x1"] })).status).toBe(400);
    const r = await h.call("POST", "/api/access/pools", { cookie: lee }, { poolid: "mine" });
    expect(r.status).toBe(403);
    expect((await j(r)).error).toContain("Pool.Allocate");
  });
});

describe("the user dialog's details", () => {
  it("aggregates groups, expiry, keys, tokens and two-factor status for one user", async () => {
    h.pve.users.get("lee@pve")!.groups = ["ops"];
    h.pve.users.get("lee@pve")!.expire = 1_900_000_000;
    h.pve.users.get("lee@pve")!.keys = "ABC!def";
    await h.call("POST", "/api/access/users/lee%40pve/tokens", { cookie: sam }, { tokenid: "ci" });
    h.pve.tfa.set("lee@pve", [{ id: "w1", type: "webauthn", description: "Key", created: 1, enable: 1 }]);
    const d = await get("/api/access/users/lee%40pve");
    expect(d).toMatchObject({ userid: "lee@pve", realmType: "pve", groups: ["ops"], expire: 1_900_000_000, keys: "ABC!def", tokens: 1, enabled: true, tfa: [expect.objectContaining({ type: "webauthn" })] });
  });

  it("creating a PAM or LDAP user never sends a password to Proxmox and explains the realm", async () => {
    const r = await j(await h.call("POST", "/api/iac/users", { cookie: sam }, { userid: "ops@pam", password: "longenough", deviceRole: "viewer" }));
    expect(r.warnings.join(" ")).toMatch(/PAM user/);
    expect(r.warnings.join(" ")).toMatch(/manages passwords itself/);
    const post = h.pve.calls.find((c) => c.method === "POST" && c.path === "/access/users")!;
    expect(post.body).not.toContain("password");
  });
});

describe("the audit trail", () => {
  it("is readable by node administrators only", async () => {
    await h.call("POST", "/api/access/groups", { cookie: sam }, { groupid: "dev" });
    const a = await get("/api/access/audit");
    expect(a.entries[0]).toMatchObject({ action: "group.create", target: "dev", actor: "sam@pve" });
    expect((await h.call("GET", "/api/access/audit", { cookie: lee })).status).toBe(403);
  });
});

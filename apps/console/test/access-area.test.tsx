// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "sam@pve", name: "Sam", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { LiveAccess } from "../src/pages/access/LiveAccess.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let db: any;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const PRIVS = [
  { name: "VM.Audit", group: "Machines", description: "See a machine and its configuration." },
  { name: "VM.PowerMgmt", group: "Machines", description: "Start, stop, reboot and suspend a machine." },
  { name: "Sys.Audit", group: "Device", description: "See the device's status, logs and configuration." },
];
const REALM_SCHEMA = {
  ldap: [
    { name: "server1", label: "Server", kind: "string", required: true, group: "connection", pattern: "^[A-Za-z0-9._:\\[\\]-]+$" },
    { name: "port", label: "Port", kind: "integer", min: 1, group: "connection" },
    { name: "mode", label: "Encryption", kind: "enum", options: ["ldap", "ldaps", "ldap+starttls"], default: "ldap", group: "connection" },
    { name: "password", label: "Bind password", kind: "secret", secret: true, group: "login" },
    { name: "base_dn", label: "Base DN", kind: "string", required: true, group: "connection" },
    { name: "user_attr", label: "User name attribute", kind: "string", required: true, group: "login" },
    { name: "verify", label: "Verify the server certificate", kind: "boolean", default: false, group: "connection" },
    { name: "comment", label: "Comment", kind: "string", group: "general" },
  ],
  pam: [{ name: "comment", label: "Comment", kind: "string", group: "general" }, { name: "tfa", label: "Enforce two-factor", kind: "string", group: "login" }],
  pve: [{ name: "comment", label: "Comment", kind: "string", group: "general" }],
};

beforeEach(() => {
  calls = [];
  db = {
    iac: {
      users: [
        { userid: "sam@pve", realm: "pve", realmType: "pve", name: "Sam", email: null, enabled: true, expire: null, groups: [], comment: null, deviceRole: "admin", orgs: [], hasEngineAccount: true },
        { userid: "ops@pam", realm: "pam", realmType: "pam", name: "ops", email: null, enabled: true, expire: null, groups: ["ops"], comment: null, deviceRole: "none", orgs: [], hasEngineAccount: false },
      ],
      orgs: [], realms: [{ realm: "pve", type: "pve" }, { realm: "pam", type: "pam" }], groups: [{ groupid: "ops" }, { groupid: "dev" }], warnings: [], canManageUsers: true,
    },
    groups: [{ groupid: "ops", comment: "Operations", members: ["ops@pam"] }],
    roles: [{ roleid: "Administrator", builtin: true, privileges: ["VM.Audit", "VM.PowerMgmt", "Sys.Audit"] }, { roleid: "Backuper", builtin: false, privileges: ["VM.Audit"] }],
    acls: [
      { path: "/", ugid: "sam@pve", type: "user", roleid: "Administrator", propagate: true, preset: "Device role: admin" },
      { path: "/vms/100", ugid: "ops", type: "group", roleid: "Backuper", propagate: true, preset: null },
    ],
    epc: [{ id: "aaaaaaaaaaaaaaaa", name: "nightly", userid: "sam@pve", createdAt: 1, expiresAt: Date.now() + 86_400_000 * 30, readOnly: true, privsep: false, pveName: "epc-aaaaaaaaaaaaaaaa", lastUsedAt: null }],
    tfa: [{ id: "t1", type: "webauthn", description: "YubiKey", created: 1_700_000_000, enabled: true }],
    realms: [
      { realm: "pam", type: "pam", comment: "Linux PAM", default: false, tfa: null, config: {}, canSync: false },
      { realm: "pve", type: "pve", comment: "Proxmox", default: true, tfa: "type=oath", config: {}, canSync: false },
      { realm: "corp", type: "ldap", comment: "Corp", default: false, tfa: null, config: { server1: "ldap.example.com", base_dn: "dc=example,dc=com", user_attr: "uid", mode: "ldaps", verify: 1 }, canSync: true },
    ],
    pools: [
      { poolid: "team", comment: "Team", members: [{ kind: "machine", id: "101", name: "web", type: "lxc" }], organization: null, orgPool: false },
      { poolid: "epc-northwind", comment: null, members: [], organization: { companyId: "c1", name: "Northwind" }, orgPool: true },
    ],
    syncPolls: 0,
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method ?? "GET";
    const p = url.pathname;
    calls.push({ method, path: p + url.search, body });
    if (p === "/api/iac") return json(db.iac);
    if (p === "/api/access/groups" && method === "GET") return json({ groups: db.groups, canManage: true });
    if (p === "/api/access/groups" && method === "POST") return json({ ok: true, warnings: [] });
    if (p === "/api/access/groups/ops/permissions") return json({ entries: [{ path: "/vms/100", roleid: "Backuper", propagate: true, privileges: ["VM.Audit"] }] });
    if (p.startsWith("/api/access/groups/") && (method === "PUT" || method === "DELETE")) return json({ ok: true, warnings: [] });
    if (p === "/api/access/roles" && method === "GET") return json({ roles: db.roles, privileges: PRIVS, canManage: true });
    if (p.startsWith("/api/access/roles")) return json({ ok: true });
    if (p === "/api/access/acl" && method === "GET") return json({ acls: db.acls, canModify: true });
    if (p === "/api/access/acl" && method === "POST") return json({ ok: true });
    if (p === "/api/access/paths") return json({ paths: [{ path: "/", label: "Everything", kind: "root" }, { path: "/vms/100", label: "web (100)", kind: "machine" }] });
    if (p === "/api/access/permissions") return json({ permissions: { "/vms/100": { "VM.Audit": 1, "Sys.Audit": 0 } } });
    if (p === "/api/access/epc-tokens" && method === "GET") return json({ tokens: db.epc, scope: "all", maxDays: 366, defaultDays: 90 });
    if (p === "/api/access/epc-tokens" && method === "POST") return json({ token: `epc_bbbbbbbbbbbbbbbb_${"S".repeat(43)}`, record: { ...db.epc[0], id: "bbbbbbbbbbbbbbbb", name: body.name, readOnly: body.readOnly, privsep: body.privsep, expiresAt: Date.now() + 86_400_000 }, proxmoxTokenId: "sam@pve!epc-bbbbbbbbbbbbbbbb", note: "This token acts as you, with all your permissions." }, 201);
    if (p.startsWith("/api/access/epc-tokens/") && method === "DELETE") return json({ ok: true, warnings: [] });
    if (p === "/api/access/users/sam%40pve/tokens" && method === "GET") return json({ tokens: [{ tokenid: "ci", fullTokenid: "sam@pve!ci", comment: "CI", expire: null, privsep: true, epaperclip: null }, { tokenid: "epc-aaaaaaaaaaaaaaaa", fullTokenid: "sam@pve!epc-aaaaaaaaaaaaaaaa", comment: null, expire: null, privsep: false, epaperclip: { id: "aaaaaaaaaaaaaaaa", name: "nightly", readOnly: true, expiresAt: 1, lastUsedAt: null } }] });
    if (p === "/api/access/users/sam%40pve/tokens" && method === "POST") return json({ fullTokenid: "sam@pve!robot", value: "11111111-2222-3333-4444-555555555555", privsep: body.privsep }, 201);
    if (p === "/api/access/tfa") return json({ users: [] });
    if (p === "/api/access/tfa/sam%40pve" && method === "GET") return json({ userid: "sam@pve", entries: db.tfa });
    if (p === "/api/access/tfa/sam%40pve" && method === "POST") return body.type === "recovery" ? json({ ok: true, id: "r1", recovery: ["1111-2222", "3333-4444"] }) : json({ ok: true, id: "t2" });
    if (p.startsWith("/api/access/tfa/sam%40pve/")) return json({ ok: true });
    if (p === "/api/access/realms" && method === "GET") return json({ realms: db.realms, canManage: true, schema: REALM_SCHEMA, types: ["pam", "pve", "ldap"], creatable: ["ldap"] });
    if (p === "/api/access/realms" && method === "POST") return json({ ok: true });
    if (p === "/api/access/realms/corp" && method === "PUT") return json({ ok: true });
    if (p === "/api/access/realms/corp/sync") return json({ task: "UPID:pve:1:1:1:auth-realm-sync:corp:sam@pve:", dryRun: body.dryRun }, 202);
    if (p.startsWith("/api/tasks/")) return json(++db.syncPolls < 2 ? { status: "running", exitstatus: null, log: ["connecting"] } : { status: "stopped", exitstatus: "OK", log: ["would create user ann@corp", "TASK OK"] });
    if (p === "/api/access/pools" && method === "GET") return json({ pools: db.pools, candidates: { machines: [{ vmid: 101, name: "web", type: "lxc" }, { vmid: 200, name: "db", type: "qemu" }], storage: ["local"] }, canManage: true });
    if (p === "/api/access/pools" && method === "POST") return json({ ok: true });
    if (p.startsWith("/api/access/pools/")) return json({ ok: true });
    if (p.startsWith("/api/access/users/")) return json({ error: "not found" }, 404);
    return json({ error: "Not found" }, 404);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LiveAccess /></QueryClientProvider>);
const openTab = async (name: string) => {
  page();
  await screen.findByText("sam@pve");
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(name) }));
};
const posted = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe("the Access area", () => {
  it("has all seven tabs and starts on Users", async () => {
    page();
    await screen.findByText("sam@pve");
    for (const t of ["Users", "Groups", "API tokens", "Two-factor", "Roles & permissions", "Realms", "Resource groups"]) expect(screen.getByRole("tab", { name: new RegExp(t.replace("&", "&")) })).toBeTruthy();
  });
});

describe("groups", () => {
  it("lists groups and creates one with members in one request", async () => {
    await openTab("Groups");
    await screen.findByText("Operations");
    fireEvent.click(screen.getByText("New group"));
    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: "dev" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Members" })).getByLabelText("sam@pve"));
    fireEvent.click(screen.getByText("Create group"));
    await waitFor(() => expect(posted("POST", "/api/access/groups")).toHaveLength(1));
    expect(posted("POST", "/api/access/groups")[0].body).toMatchObject({ groupid: "dev", members: ["sam@pve"] });
  });

  it("shows what a group can do and saves member changes", async () => {
    await openTab("Groups");
    fireEvent.click(await screen.findByText("ops"));
    await screen.findByText("Backuper");
    expect(screen.getByText(/1 privilege/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Members" })).getByLabelText("ops@pam"));
    fireEvent.click(screen.getByText("Save group"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/access/groups/ops")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ members: [] });
  });

  it("won't create a group with a bad name", async () => {
    await openTab("Groups");
    fireEvent.click(await screen.findByText("New group"));
    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: "bad name" } });
    expect((screen.getByText("Create group").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("roles and permissions", () => {
  it("lists every ACL, marks presets, filters, and removes one", async () => {
    await openTab("Roles & permissions");
    await screen.findByText("Device role: admin");
    expect(screen.getAllByText("Set by hand")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "group" } });
    expect(screen.queryByText("Device role: admin")).toBeNull();
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Only ones set by hand"));
    expect(screen.queryByText("Device role: admin")).toBeNull();
    fireEvent.click(screen.getByLabelText("Remove Backuper for ops on /vms/100"));
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(posted("POST", "/api/access/acl")).toHaveLength(1));
    expect(posted("POST", "/api/access/acl")[0].body).toEqual({ path: "/vms/100", roles: ["Backuper"], groups: ["ops"], remove: true });
  });

  it("adds a permission on a path with autocomplete choices", async () => {
    await openTab("Roles & permissions");
    fireEvent.click(await screen.findByText("Add permission"));
    const dialog = screen.getByRole("dialog");
    const path = await within(dialog).findByLabelText("Path");
    await waitFor(() => expect(document.querySelectorAll("#acl-path-list option").length).toBe(2));
    fireEvent.change(path, { target: { value: "/vms/100" } });
    fireEvent.change(within(dialog).getByLabelText("User"), { target: { value: "sam@pve" } });
    fireEvent.change(within(dialog).getByLabelText("Role"), { target: { value: "Backuper" } });
    fireEvent.click(within(dialog).getByText("Add permission", { selector: "button" }));
    await waitFor(() => expect(posted("POST", "/api/access/acl")).toHaveLength(1));
    expect(posted("POST", "/api/access/acl")[0].body).toEqual({ path: "/vms/100", roles: ["Backuper"], propagate: true, users: ["sam@pve"] });
  });

  it("lists roles, keeps built-ins read-only and creates a custom role from privileges with descriptions", async () => {
    await openTab("Roles & permissions");
    fireEvent.click(await screen.findByRole("radio", { name: "Roles" }));
    fireEvent.click(await screen.findByText("Administrator"));
    expect(await screen.findByText("Start, stop, reboot and suspend a machine.")).toBeTruthy();
    expect(screen.queryByText("Save role")).toBeNull();
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("New role"));
    fireEvent.change(await screen.findByLabelText("Role name"), { target: { value: "Viewer2" } });
    fireEvent.click(screen.getByLabelText(/VM.Audit/));
    fireEvent.click(screen.getByText("Create role"));
    await waitFor(() => expect(posted("POST", "/api/access/roles")).toHaveLength(1));
    expect(posted("POST", "/api/access/roles")[0].body).toEqual({ roleid: "Viewer2", privileges: ["VM.Audit"] });
  });

  it("checks effective permissions for a user on a path", async () => {
    await openTab("Roles & permissions");
    fireEvent.click(await screen.findByRole("radio", { name: "Check access" }));
    fireEvent.change(await screen.findByLabelText("User or API token"), { target: { value: "sam@pve" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/vms/100" } });
    fireEvent.click(screen.getByRole("button", { name: "Check access" }));
    await screen.findByText((_, el) => el?.tagName === "P" && /holds 1 privilege on/.test(el.textContent ?? ""));
    expect(screen.getByText("See a machine and its configuration.")).toBeTruthy();
    expect(screen.queryByText("See the device's status, logs and configuration.")).toBeNull();
    expect(calls.some((c) => c.path === "/api/access/permissions?userid=sam%40pve&path=%2Fvms%2F100")).toBe(true);
  });
});

describe("API tokens", () => {
  it("shows the new ePaperclip token once, with privilege separation explained, and not again after closing", async () => {
    await openTab("API tokens");
    await screen.findByText("nightly");
    fireEvent.click(screen.getByText("New API token"));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("switch", { name: "Read-only" }));
    fireEvent.click(screen.getByText("Create token"));
    const secret = (await screen.findAllByTestId("secret-value", undefined, { timeout: 2000 }))[0];
    expect(posted("POST", "/api/access/epc-tokens")[0].body).toMatchObject({ name: "deploy", readOnly: true, privsep: false, expiresInDays: 90 });
    expect(secret.textContent).toMatch(/^epc_b{16}_S{43}$/);
    expect(screen.getByText(/Mutations don't need a browser header/)).toBeTruthy();
    // Closing needs the confirmation; afterwards the secret is gone from the page and from later requests.
    const done = screen.getByText("Done").closest("button") as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I've saved it"));
    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByTestId("secret-value")).toBeNull());
    expect(document.body.textContent).not.toContain("S".repeat(43));
  });

  it("explains separate privileges when creating, and revokes after a second click", async () => {
    await openTab("API tokens");
    fireEvent.click(await screen.findByText("New API token"));
    expect((await screen.findAllByText(/has no permissions of its own/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByLabelText("Revoke nightly"));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    fireEvent.click(await screen.findByText("Revoke"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/access/epc-tokens/aaaaaaaaaaaaaaaa")).toBe(true));
  });

  it("lists Proxmox tokens, marks ePaperclip's, and shows a new token's value once", async () => {
    await openTab("API tokens");
    await screen.findByText("sam@pve!ci");
    expect(screen.getByText("ePaperclip: nightly")).toBeTruthy();
    fireEvent.click(screen.getByText("New Proxmox token"));
    fireEvent.change(await screen.findByLabelText(/Token name/), { target: { value: "robot" } });
    fireEvent.click(screen.getByText("Create token"));
    await screen.findByText("11111111-2222-3333-4444-555555555555");
    expect(posted("POST", "/api/access/users/sam%40pve/tokens")[0].body).toMatchObject({ tokenid: "robot", privsep: true });
    expect(screen.getByText(/can do nothing until you give it permissions/)).toBeTruthy();
  });
});

describe("two-factor", () => {
  it("draws the authenticator QR code in the browser as SVG, never through an image or another site", async () => {
    await openTab("Two-factor");
    await screen.findByText("YubiKey");
    fireEvent.click(screen.getByText("Authenticator app", { selector: "button" }));
    const svg = await screen.findByRole("img", { name: /Scan to add sam@pve/ });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.querySelector("path")!.getAttribute("d")!.length).toBeGreaterThan(500);
    expect(document.querySelector("img, canvas, iframe")).toBeNull();
    expect(calls.every((c) => new URL(c.path, "http://x").origin === "http://x")).toBe(true);
    const key = screen.getByTestId("setup-key").textContent!.replace(/\s/g, "");
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("adds the authenticator with the otpauth link, the current code and the person's password", async () => {
    await openTab("Two-factor");
    await screen.findByText("YubiKey");
    fireEvent.click(screen.getByText("Authenticator app", { selector: "button" }));
    const key = (await screen.findByTestId("setup-key")).textContent!.replace(/\s/g, "");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Phone" } });
    fireEvent.change(screen.getByLabelText("Current code"), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(screen.getByText("Add authenticator"));
    await waitFor(() => expect(posted("POST", "/api/access/tfa/sam%40pve")).toHaveLength(1));
    const b = posted("POST", "/api/access/tfa/sam%40pve")[0].body;
    expect(b).toMatchObject({ type: "totp", value: "123456", description: "Phone", password: "right" });
    expect(b.totp).toContain(`secret=${key}`);
    expect(b.totp).toMatch(/^otpauth:\/\/totp\//);
  });

  it("shows recovery keys once", async () => {
    await openTab("Two-factor");
    fireEvent.click(await screen.findByText("Recovery keys", { selector: "button" }));
    fireEvent.change(await screen.findByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(screen.getByText("Create keys"));
    const keys = await screen.findByTestId("secret-value");
    expect(keys.textContent).toBe("1111-2222\n3333-4444");
    fireEvent.click(screen.getByLabelText("I've saved it"));
    fireEvent.click(screen.getByText("Done"));
    await waitFor(() => expect(screen.queryByTestId("secret-value")).toBeNull());
  });

  it("lists security keys with removal and says they're added in Proxmox", async () => {
    await openTab("Two-factor");
    await screen.findByText("YubiKey");
    expect(screen.getByText("Security key", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/Anyone.s keys can be removed by an administrator/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Remove Security key"));
    fireEvent.change(await screen.findByLabelText("Your password"), { target: { value: "right" } });
    fireEvent.click(screen.getByText("Remove", { selector: "button" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/access/tfa/sam%40pve/t1")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ password: "right" });
  });
});

describe("realms", () => {
  it("lists realms and shows TFA enforcement", async () => {
    await openTab("Realms");
    await screen.findByText("corp");
    expect(screen.getByText("Required: oath")).toBeTruthy();
    expect(screen.getByText("ldap.example.com")).toBeTruthy();
  });

  it("renders the form from the schema, validates it, and sends the bind password write-only", async () => {
    await openTab("Realms");
    fireEvent.click(await screen.findByText("Add realm"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("LDAP"));
    fireEvent.change(await screen.findByLabelText("Realm name"), { target: { value: "dir" } });
    const create = screen.getByText("Create realm").closest("button") as HTMLButtonElement;
    expect(create.disabled).toBe(true); // server, base DN and attribute are required
    fireEvent.change(screen.getByLabelText(/^Server/), { target: { value: "bad host!" } });
    expect(await screen.findByText("That isn't in the expected form")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Server/), { target: { value: "ldap.example.com" } });
    fireEvent.change(screen.getByLabelText(/^Base DN/), { target: { value: "dc=x,dc=y" } });
    fireEvent.change(screen.getByLabelText(/^User name attribute/), { target: { value: "uid" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "99999" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "636" } });
    const pw = screen.getByLabelText("Bind password") as HTMLInputElement;
    expect(pw.type).toBe("password");
    fireEvent.change(pw, { target: { value: "s3cret-bind" } });
    fireEvent.click(create);
    await waitFor(() => expect(posted("POST", "/api/access/realms")).toHaveLength(1));
    expect(posted("POST", "/api/access/realms")[0].body).toEqual({ realm: "dir", type: "ldap", server1: "ldap.example.com", base_dn: "dc=x,dc=y", user_attr: "uid", port: 636, password: "s3cret-bind" });
  });

  it("never prefills secrets when editing, and sends only what changed", async () => {
    await openTab("Realms");
    fireEvent.click(await screen.findByText("corp"));
    const pw = (await screen.findByLabelText("Bind password")) as HTMLInputElement;
    expect(pw.value).toBe("");
    expect(screen.getByText(/Leave empty to keep what Proxmox has/)).toBeTruthy();
    expect((screen.getByLabelText(/^Server/) as HTMLInputElement).value).toBe("ldap.example.com");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Corporate" } });
    fireEvent.click(screen.getByText("Save realm"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/access/realms/corp")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ comment: "Corporate" });
    expect(document.body.textContent).not.toContain("SHOULD-NEVER");
  });

  it("runs a dry-run sync as a task, follows its log and offers the real run afterwards", async () => {
    await openTab("Realms");
    await screen.findByText("corp");
    fireEvent.click(screen.getByText("Sync"));
    fireEvent.click(await screen.findByText("Start dry run"));
    await waitFor(() => expect(posted("POST", "/api/access/realms/corp/sync")).toHaveLength(1));
    expect(posted("POST", "/api/access/realms/corp/sync")[0].body).toMatchObject({ dryRun: true, scope: "both" });
    await waitFor(() => expect(screen.getByLabelText("Sync log").textContent).toContain("would create user ann@corp"), { timeout: 5000 });
    expect(await screen.findByText("Dry run finished. Nothing was changed.")).toBeTruthy();
    fireEvent.click(screen.getByText("Run it for real"));
    await waitFor(() => expect(posted("POST", "/api/access/realms/corp/sync")).toHaveLength(2));
    expect(posted("POST", "/api/access/realms/corp/sync")[1].body.dryRun).toBe(false);
  }, 15000);
});

describe("resource groups", () => {
  it("marks organization groups and refuses to delete one that an organization uses", async () => {
    await openTab("Resource groups");
    await screen.findByText("Organization: Northwind");
    fireEvent.click(screen.getByText("epc-northwind"));
    expect(await screen.findByText("Resource group of Northwind")).toBeTruthy();
    fireEvent.click(screen.getByText("Delete"));
    expect(await screen.findByText("This group can't be deleted")).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("adds and removes machines and storage", async () => {
    await openTab("Resource groups");
    fireEvent.click(await screen.findByText("team"));
    await screen.findByText("web");
    fireEvent.change(screen.getByLabelText("Add a machine"), { target: { value: "200" } });
    fireEvent.click(within(screen.getByLabelText("Add a machine").closest("div")!).getByText("Add"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/access/pools/team")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ addVms: ["200"] });
    fireEvent.click(screen.getByLabelText("Remove web from the group"));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PUT")[1].body).toEqual({ removeVms: ["101"] });
  });
});

describe("the user dialog", () => {
  it("explains PAM users, hides the password and sends no password", async () => {
    page();
    await screen.findByText("sam@pve");
    fireEvent.click(screen.getByText("New user"));
    fireEvent.change(await screen.findByPlaceholderText("sam@pve"), { target: { value: "dev@pam" } });
    expect(await screen.findByText("Managed in the operating system")).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByText("Create user"));
    await waitFor(() => expect(posted("POST", "/api/iac/users")).toHaveLength(1));
    expect(posted("POST", "/api/iac/users")[0].body).not.toHaveProperty("password");
  });

  it("assigns groups and an expiry date when editing", async () => {
    page();
    fireEvent.click(await screen.findByText("ops@pam"));
    const groups = await screen.findByRole("group", { name: "Members" });
    expect((within(groups).getByLabelText("ops") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(groups).getByLabelText("dev"));
    fireEvent.change(screen.getByLabelText("Account expires"), { target: { value: "2030-01-31" } });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/api/iac/users/ops%40pam")).toBe(true));
    const body = calls.find((c) => c.method === "PUT")!.body;
    expect(body.groups.sort()).toEqual(["dev", "ops"]);
    expect(body.expire).toBe(Math.floor(new Date("2030-01-31T23:59:59").getTime() / 1000));
  });
});

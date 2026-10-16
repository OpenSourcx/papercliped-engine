// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "sam@pve", name: "Sam", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { LiveAccess } from "../src/pages/access/LiveAccess.tsx";
import { deviceOf } from "../src/pages/access/SecurityTab.tsx";
import { PathPermissions } from "../src/pages/access/PathPermissions.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let db: any;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ORG = { companyId: "c1", name: "Northwind", pool: "epc-northwind" };

beforeEach(() => {
  calls = [];
  db = {
    sessions: [
      { handle: "aaaaaaaaaaaaaaaa", username: "sam@pve", createdAt: 1_800_000_000_000, lastSeen: 1_800_000_100_000, expiresAt: 1_800_007_000_000, ip: "10.0.0.5", agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/130", via: "password", current: true },
      { handle: "bbbbbbbbbbbbbbbb", username: "sam@pve", createdAt: 1_800_000_000_000, lastSeen: 1_800_000_100_000, expiresAt: 1_800_007_000_000, ip: "10.0.0.9", agent: "Mozilla/5.0 (iPhone) Safari/604", via: "openid", current: false },
    ],
    audit: [
      { at: 1_800_000_200_000, actor: "sam@pve", action: "user.create", target: "ann@pve", detail: "device role viewer", ip: "10.0.0.5" },
      { at: 1_800_000_100_000, actor: "lee@pve", action: "session.sign-in", detail: "password", ip: "10.0.0.7" },
    ],
    policy: { webauthn: null, u2f: null, consentText: "Authorised use only.", canManage: true },
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method ?? "GET";
    const p = url.pathname;
    calls.push({ method, path: p + url.search, body });
    if (p === "/api/iac") return json({ users: [{ userid: "sam@pve", realm: "pve", realmType: "pve", name: "Sam", email: null, enabled: true, expire: null, groups: [], comment: null, deviceRole: "admin", orgs: [], hasEngineAccount: true }, { userid: "lee@pve", realm: "pve", realmType: "pve", name: "Lee", email: null, enabled: true, expire: null, groups: ["ops"], comment: null, deviceRole: "viewer", orgs: [{ companyId: "c1", role: "viewer" }], hasEngineAccount: true }], orgs: [ORG], realms: [{ realm: "pve", type: "pve" }], groups: [{ groupid: "ops" }], warnings: [], canManageUsers: true });
    if (p === "/api/access/password") return body.currentPassword === "wrong" ? json({ error: "Your current password isn't right", code: "bad_current_password" }, 403) : json({ ok: true, otherSessionsEnded: 1 });
    if (p === "/api/access/sessions" && method === "GET") return json({ sessions: db.sessions, scope: url.searchParams.get("all") ? "all" : "mine", canManageOthers: true });
    if (p.startsWith("/api/access/sessions/") && method === "DELETE") return json({ ok: true });
    if (p === "/api/access/sessions/revoke-others") return json({ ok: true, ended: 1 });
    if (p === "/api/access/audit") return json({ entries: db.audit.filter((e: any) => !url.searchParams.get("actor") || e.actor === url.searchParams.get("actor")), total: 2, kept: 2, actors: ["lee@pve", "sam@pve"], actions: ["session.sign-in", "user.create"] });
    if (p === "/api/access/signin-policy" && method === "GET") return json(db.policy);
    if (p === "/api/access/signin-policy") return json({ ok: true });
    if (p === "/api/access/explorer") return json({ userid: "lee@pve", isToken: false, privsep: false, groups: ["ops"], note: null, entries: [{ path: "/vms", role: "PVEAuditor", propagate: true, source: "group ops", privileges: ["VM.Audit"] }], effective: [{ path: "/vms", privileges: ["VM.Audit"], grants: { "VM.Audit": [{ role: "PVEAuditor", at: "/vms", source: "group ops" }] } }] });
    if (p === "/api/access/preview") return json({ changes: [{ kind: "acl", op: "add", path: "/", role: "PVEAuditor", privileges: ["VM.Audit"], reason: "Device role: viewer" }, { kind: "engine", op: "add", companyId: "c1", org: "Northwind", from: null, to: "operator", text: "Joins Northwind as operator" }, { kind: "effect", text: "Their open ePaperclip sessions end." }], warnings: [] });
    if (p === "/api/access/templates" && method === "GET") return json({ templates: [{ id: "t0123456789", name: "Contractor", groups: ["ops"], deviceRole: "viewer", orgs: [{ companyId: "*", role: "operator" }] }] });
    if (p === "/api/access/templates") return json({ template: { id: "t9999999999" } }, 201);
    if (p === "/api/access/templates/t0123456789/apply") return json({ dryRun: body.dryRun, results: [{ userid: "lee@pve", changes: [{ kind: "engine", op: "change", companyId: "c1", org: "Northwind", from: "viewer", to: "operator", text: "Northwind: viewer → operator" }], warnings: [], applied: !body.dryRun }] });
    if (p === "/api/access/import/preview") return json({ rows: [{ line: 2, userid: "ann@pve", action: "create", errors: [], warnings: ["No password: they can't sign in until you set one."], summary: { name: "Ann Lee", email: null, groups: ["ops"], deviceRole: "viewer", orgs: [{ companyId: "c1", org: "Northwind", role: "operator" }], template: null, realmType: "pve", passwordKept: false }, changes: [] }, { line: 3, userid: "bad", action: "error", errors: ["A user name looks like name@realm"], warnings: [], summary: { name: "", email: null, groups: [], deviceRole: null, orgs: [], template: null, realmType: null, passwordKept: false } }], problems: [], newGroups: [], counts: { create: 1, update: 0, skip: 0, error: body.csv.includes("bad") ? 1 : 0 } });
    if (p === "/api/access/import/apply") return json({ results: [{ line: 2, userid: "ann@pve", status: "created", warnings: [], password: "Gen3rated-pw" }], counts: { created: 1, updated: 0, skipped: 0, failed: 0 } });
    if (p === "/api/access/group-map" && method === "GET") return json({ mappings: [{ id: "m1", group: "ops", companyId: "c1", role: "viewer" }], groups: ["ops", "dev"], orgs: [{ companyId: "c1", name: "Northwind" }], roles: ["viewer", "operator", "admin", "owner"] });
    if (p === "/api/access/group-map" && method === "PUT") return json({ mappings: body.mappings });
    if (p === "/api/access/group-map/sync") return json({ dryRun: body.dryRun, operations: [{ op: "grant", userid: "kim@pve", companyId: "c1", org: "Northwind", from: null, to: "viewer", because: "member of ops", applied: !body.dryRun }] });
    if (p === "/api/access/routine-ingress" && method === "GET") return json({ organizations: [{ companyId: "c1", name: "Northwind", enabled: true, enabledAt: 1_800_000_000_000, by: "sam@pve", error: null, hooks: [{ routineId: "r1", routine: "Deploy", triggerId: "t1", label: null, publicId: "0123456789abcdef01234567", signingMode: "none", enabled: true }] }], path: "/hooks/routines/{id}/fire", maxBodyBytes: 65536, limits: { perAddressPerMinute: 60, perTriggerPerMinute: 30, overallPerMinute: 600 } });
    if (p.startsWith("/api/access/routine-ingress/")) return json({ ok: true });
    if (p === "/api/access/sync-jobs" && method === "GET") return json({ jobs: [{ id: "nightly", realm: "corp", schedule: "daily", scope: "both", enabled: true, enableNew: true, removeVanished: [], comment: null, nextRun: 1_800_086_400, lastRun: null, status: null }] });
    if (p === "/api/access/sync-jobs/preview") return json({ times: [1_800_086_400, 1_800_172_800] });
    if (p.startsWith("/api/access/sync-jobs")) return json({ ok: true });
    if (p === "/api/access/realms") return json({ realms: [{ realm: "corp", type: "ldap", comment: "Corp", default: false, tfa: null, config: { server1: "ldap.example.com" }, canSync: true }], canManage: true, schema: { ldap: [] }, types: ["ldap"], creatable: ["ldap"] });
    if (p === "/api/access/epc-tokens" && method === "GET") return json({ tokens: [{ id: "aaaaaaaaaaaaaaaa", name: "nightly", userid: "sam@pve", createdAt: 1, expiresAt: Date.now() + 86_400_000 * 3, readOnly: false, privsep: false, pveName: "epc-aaaaaaaaaaaaaaaa", lastUsedAt: null }], scope: "all", maxDays: 366, defaultDays: 90 });
    if (p.endsWith("/renew")) return json({ record: { id: "aaaaaaaaaaaaaaaa", expiresAt: Date.now() + 86_400_000 * 90 } });
    if (p.endsWith("/rotate")) return json({ token: `epc_aaaaaaaaaaaaaaaa_${"N".repeat(43)}`, record: { id: "aaaaaaaaaaaaaaaa", name: "nightly", expiresAt: Date.now() + 86_400_000 * 90, privsep: false } });
    if (p === "/api/access/acl" && method === "GET") return json({ acls: [{ path: "/storage/local", ugid: "ops", type: "group", roleid: "PVEDatastoreUser", propagate: true, preset: null }, { path: "/", ugid: "sam@pve", type: "user", roleid: "Administrator", propagate: true, preset: null }], canModify: true });
    if (p === "/api/access/acl") return json({ ok: true });
    if (p === "/api/access/roles") return json({ roles: [{ roleid: "PVEDatastoreUser", builtin: true, privileges: ["Datastore.Audit"] }, { roleid: "PVEAuditor", builtin: true, privileges: [] }], privileges: [], canManage: true });
    if (p === "/api/access/paths") return json({ paths: [] });
    if (p.endsWith("/tokens")) return json({ tokens: [] });
    if (p.startsWith("/api/access/users/") || p === "/api/access/groups") return json(p === "/api/access/groups" ? { groups: [], canManage: true } : { tfa: [], tokens: 0, keys: "", expire: null, realmTfa: null });
    if (p.startsWith("/api/iac/users/")) return json({ userid: "lee@pve", warnings: [] });
    return json({ error: "Not found" }, 404);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LiveAccess /></QueryClientProvider>);
const openTab = async (name: string | RegExp) => {
  page();
  await screen.findByText("sam@pve");
  fireEvent.click(screen.getByRole("tab", { name }));
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe("tabs", () => {
  it("adds the new areas next to the old ones", async () => {
    page();
    await screen.findByText("sam@pve");
    for (const t of ["Effective permissions", "Import & templates", "Audit log", "Sign-in policy", "My security"]) expect(screen.getByRole("tab", { name: t })).toBeTruthy();
  });
});

describe("My security", () => {
  it("changes your password with the current one and says other sessions were signed out", async () => {
    await openTab("My security");
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "right" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-password" } });
    const change = screen.getByRole("button", { name: /Change password/ });
    expect((change as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New password again"), { target: { value: "a-new-password" } });
    fireEvent.click(change);
    await screen.findByText(/Password changed. 1 other session signed out/);
    expect(sent("POST", "/api/access/password")[0].body).toEqual({ currentPassword: "right", password: "a-new-password" });
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("shows a wrong current password as an error", async () => {
    await openTab("My security");
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "wrong" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-password" } });
    fireEvent.change(screen.getByLabelText("New password again"), { target: { value: "a-new-password" } });
    fireEvent.click(screen.getByRole("button", { name: /Change password/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/current password isn't right/);
  });

  it("lists sessions, marks this one, signs another out and signs out everywhere else", async () => {
    await openTab("My security");
    await screen.findByText("Chrome on macOS");
    expect(screen.getByText("This session")).toBeTruthy();
    expect(screen.getByText("Safari on iOS")).toBeTruthy();
    expect(screen.getByText("OpenID Connect")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Sign out Safari on iOS from 10.0.0.9/ }));
    await waitFor(() => expect(sent("DELETE", "/api/access/sessions/bbbbbbbbbbbbbbbb")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Sign out everywhere else/ }));
    await waitFor(() => expect(sent("POST", "/api/access/sessions/revoke-others")).toHaveLength(1));
  });

  it("reads a device out of a user agent", () => {
    expect(deviceOf("Mozilla/5.0 (Windows NT 10) Firefox/120")).toBe("Firefox on Windows");
    expect(deviceOf(null)).toBe("Unknown device");
    expect(deviceOf("curl/8.0")).toBe("Script");
  });
});

describe("Audit log", () => {
  it("shows entries, filters by person, and links to the CSV and JSON exports with the same filter", async () => {
    await openTab("Audit log");
    const table = await screen.findByRole("table");
    await within(table).findByText("user.create");
    expect(within(table).getByText("session.sign-in")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: "lee@pve" } });
    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("user.create")).toBeNull());
    const csv = screen.getByText("CSV").closest("a")!;
    expect(csv.getAttribute("href")).toBe("/api/access/audit/export?actor=lee%40pve&format=csv");
    expect(screen.getByText("JSON").closest("a")!.getAttribute("href")).toContain("format=json");
  });
});

describe("Effective permissions", () => {
  it("shows the entries and, for a path, which role and group grant each privilege", async () => {
    await openTab("Effective permissions");
    fireEvent.change(await screen.findByLabelText("User or API token"), { target: { value: "lee@pve" } });
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    await screen.findByText(/Entries that apply to lee@pve \(in ops\)/);
    expect(screen.getByText("PVEAuditor")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /\/vms\s*1 privileges/ }));
    expect(screen.getByText(/PVEAuditor on \/vms \(group ops\)/)).toBeTruthy();
    expect(sent("GET", "/api/access/explorer?userid=lee%40pve")).toHaveLength(1);
  });
});

describe("Sign-in policy", () => {
  it("shows the login notice, saves a changed one, and fills this page's address for security keys", async () => {
    await openTab("Sign-in policy");
    const notice = await screen.findByLabelText("Notice");
    expect((notice as HTMLTextAreaElement).value).toBe("Authorised use only.");
    fireEvent.change(notice, { target: { value: "Keep out." } });
    fireEvent.click(screen.getByRole("button", { name: "Save notice" }));
    await waitFor(() => expect(sent("PUT", "/api/access/signin-policy")[0]?.body).toEqual({ consentText: "Keep out." }));
    fireEvent.click(screen.getByRole("button", { name: "Use this page's address" }));
    expect((screen.getByLabelText("Origin") as HTMLInputElement).value).toBe(window.location.origin);
  });

  it("lists routine webhook addresses for open organizations and warns about unsigned triggers", async () => {
    await openTab("Sign-in policy");
    await screen.findByText("Deploy");
    expect(screen.getByText(`${window.location.origin}/hooks/routines/0123456789abcdef01234567/fire`)).toBeTruthy();
    expect(screen.getByText("No signature check")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: /Accept webhooks from outside for Northwind/ }));
    await waitFor(() => expect(sent("PUT", "/api/access/routine-ingress/c1")[0]?.body).toEqual({ enabled: false }));
  });
});

describe("Import & templates", () => {
  it("previews a CSV, blocks applying while a row has an error, then imports and shows the made passwords once", async () => {
    await openTab("Import & templates");
    const box = await screen.findByLabelText("CSV");
    fireEvent.change(box, { target: { value: "username\nann\nbad name" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByLabelText("Import preview");
    expect(screen.getByText("A user name looks like name@realm")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Import 1 person/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "username\nann" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const go = await screen.findByRole("button", { name: /Import 1 person/ });
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(go);
    await screen.findByText(/1 created, 0 updated/);
    expect(screen.getByTestId("secret-value").textContent).toBe("username,password\nann@pve,Gen3rated-pw");
    expect(sent("POST", "/api/access/import/apply")[0].body).toMatchObject({ csv: "username\nann", existing: "skip", generatePasswords: true, defaultRealm: "pve" });
  });

  it("applies a template to chosen people after previewing what changes", async () => {
    await openTab("Import & templates");
    fireEvent.click(screen.getByRole("radio", { name: "Templates" }));
    await screen.findByText("Contractor");
    fireEvent.click(screen.getByRole("button", { name: "Apply…" }));
    fireEvent.click(await screen.findByLabelText(/lee@pve/));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText("Northwind: viewer → operator");
    expect(sent("POST", "/api/access/templates/t0123456789/apply")[0].body).toEqual({ userids: ["lee@pve"], dryRun: true });
    fireEvent.click(screen.getByRole("button", { name: /Apply to 1 person/ }));
    await screen.findByText("Done");
    expect(sent("POST", "/api/access/templates/t0123456789/apply")[1].body.dryRun).toBe(false);
  });

  it("maps a group to an organization role, previews the sync, then applies it", async () => {
    await openTab("Import & templates");
    fireEvent.click(screen.getByRole("radio", { name: "Group mapping" }));
    await screen.findByLabelText("Group");
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "operator" } });
    fireEvent.click(screen.getByRole("button", { name: "Save mappings" }));
    await waitFor(() => expect(sent("PUT", "/api/access/group-map")[0]?.body.mappings[0]).toMatchObject({ group: "ops", companyId: "c1", role: "operator" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview a sync" }));
    await screen.findByText("Joins as viewer");
    fireEvent.click(screen.getByRole("button", { name: /Apply 1 change/ }));
    await screen.findByText("Done");
  });
});

describe("Realms: scheduled syncs", () => {
  it("lists jobs and creates one with a preview of the next runs", async () => {
    await openTab("Realms");
    await screen.findByText("nightly");
    fireEvent.click(screen.getByRole("button", { name: /Schedule a sync/ }));
    fireEvent.change(await screen.findByLabelText(/Job id/), { target: { value: "weekly" } });
    await screen.findByText(/Next runs:/);
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(sent("POST", "/api/access/sync-jobs")[0]?.body).toMatchObject({ id: "weekly", realm: "corp", schedule: "daily", scope: "both" }));
  });
});

describe("API tokens: renewing", () => {
  it("renews a token and rotates its secret, showing the new one once", async () => {
    await openTab("API tokens");
    await screen.findByText("nightly");
    expect(screen.getByText(/Expires soon/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Renew nightly" }));
    await waitFor(() => expect(sent("POST", "/api/access/epc-tokens/aaaaaaaaaaaaaaaa/renew")[0]?.body).toEqual({ expiresInDays: 90 }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate nightly" }));
    await waitFor(() => expect(screen.getAllByTestId("secret-value")[0].textContent).toContain(`epc_aaaaaaaaaaaaaaaa_${"N".repeat(43)}`));
  });
});

describe("changing a person's access", () => {
  it("shows what will change in Proxmox and the engine first, then applies on a second click", async () => {
    page();
    fireEvent.click(await screen.findByText("Lee"));
    const select = await screen.findByLabelText("Role in Northwind");
    fireEvent.change(select, { target: { value: "operator" } });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const review = await screen.findByLabelText("Review changes");
    expect(within(review).getByText("Joins Northwind as operator")).toBeTruthy();
    expect(within(review).getByText("Their open ePaperclip sessions end.")).toBeTruthy();
    expect(sent("PUT", "/api/iac/users/lee%40pve")).toHaveLength(0);
    expect(sent("POST", "/api/access/preview")[0].body).toMatchObject({ userid: "lee@pve", orgs: [{ companyId: "c1", role: "operator" }] });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(sent("PUT", "/api/iac/users/lee%40pve")).toHaveLength(1));
  });

  it("saves straight away when only details change", async () => {
    page();
    fireEvent.click(await screen.findByText("Lee"));
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "lee@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sent("PUT", "/api/iac/users/lee%40pve")).toHaveLength(1));
    expect(sent("POST", "/api/access/preview")).toHaveLength(0);
  });
});

describe("who can use one thing", () => {
  const view = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PathPermissions path="/storage/local" noun="storage" /></QueryClientProvider>);

  it("lists what is granted on its own path only, and revokes after the role is typed", async () => {
    view();
    await screen.findByText("Group ops");
    expect(screen.queryByText("sam@pve")).toBeNull(); // granted on /, not on this storage
    fireEvent.click(screen.getByRole("button", { name: "Revoke PVEDatastoreUser from ops" }));
    const go = screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type the role to confirm"), { target: { value: "PVEDatastoreUser" } });
    fireEvent.click(go);
    await waitFor(() => expect(sent("POST", "/api/access/acl")[0]?.body).toEqual({ path: "/storage/local", roles: ["PVEDatastoreUser"], groups: ["ops"], remove: true }));
  });

  it("grants on that path", async () => {
    view();
    fireEvent.click(await screen.findByRole("button", { name: /Grant access/ }));
    expect(((await screen.findByLabelText("Path")) as HTMLInputElement).value).toBe("/storage/local");
  });
});

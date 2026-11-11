// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/auth/session.tsx", () => ({
  useSession: () => ({ session: { mode: "live", user: { username: "sam@pve", name: "Sam", realm: "pve", node: "pve" } }, signOut: async () => {} }),
}));

import { LiveAccess } from "../src/pages/access/LiveAccess.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let admin: boolean;
let drift: any[];

const user = (userid: string, over: Record<string, unknown> = {}) => ({ userid, realm: "pve", realmType: "pve", name: userid.split("@")[0], email: null, enabled: true, expire: null, groups: [], comment: null, deviceRole: "none", orgs: [], hasEngineAccount: true, ...over });

beforeEach(() => {
  calls = [];
  admin = true;
  drift = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/api/iac")
      return new Response(JSON.stringify({ users: [user("sam@pve", { deviceRole: "admin", orgs: [{ companyId: "c1", role: "owner" }] }), user("lee@pve")], orgs: [{ companyId: "c1", name: "Northwind", pool: "epc-northwind" }, { companyId: "c2", name: "Lumen", pool: null }], realms: [], groups: [], warnings: [], canManageUsers: true, admin }), { status: 200 });
    if (method === "GET" && url.pathname === "/api/iac/drift") return new Response(JSON.stringify({ items: drift, sync: {} }), { status: 200 });
    if (method === "POST" && url.pathname.endsWith("/join")) return new Response(JSON.stringify({ ok: true, userid: body.userid ?? "sam@pve", role: body.role ?? "admin", joined: true }), { status: 200 });
    if (method === "POST" && url.pathname === "/api/iac/drift/repair") return new Response(JSON.stringify({ repaired: 1, results: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LiveAccess /></QueryClientProvider>);

describe("organizations on this device (ERR-SYNC-001)", () => {
  it("shows an administrator which organizations they can open and offers Join for the others", async () => {
    page();
    await screen.findByText("Organizations on this device");
    expect(screen.getByText("You: owner")).toBeTruthy();
    expect(screen.getByText("Not a member")).toBeTruthy();
    expect(screen.queryByLabelText("Join Northwind as admin")).toBeNull();
    fireEvent.click(screen.getByLabelText("Join Lumen as admin"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/iac/orgs/c2/join")).toBe(true));
    await screen.findByText(/now has the admin role/);
  });

  it("grants another user a role", async () => {
    page();
    await screen.findByText("Organizations on this device");
    fireEvent.click(screen.getByLabelText("Grant access to Lumen"));
    fireEvent.change(screen.getByLabelText("Proxmox user to grant Lumen"), { target: { value: "lee@pve" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "operator" } });
    fireEvent.click(screen.getByText("Grant"));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/iac/orgs/c2/join")?.body).toEqual({ userid: "lee@pve", role: "operator" }));
  });

  it("is not offered to anyone who is not a Proxmox administrator", async () => {
    admin = false;
    page();
    await screen.findByText("sam@pve");
    expect(screen.queryByText("Organizations on this device")).toBeNull();
    expect(calls.some((c) => c.path === "/api/iac/drift")).toBe(false);
  });

  it("lists drift and repairs it on request", async () => {
    drift = [{ kind: "missing-acl", companyId: "c1", org: "Northwind", userid: "lee@pve", role: "PVEVMUser", detail: "lee@pve is a member of Northwind but doesn't have PVEVMUser on epc-northwind", repair: "grant" }];
    page();
    await screen.findByText(/doesn't have PVEVMUser/);
    fireEvent.click(screen.getByText("Repair"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/iac/drift/repair")).toBe(true));
    await screen.findByText(/1 repaired/);
  });
});

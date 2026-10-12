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
let overview: any;
let canManage: boolean;

const user = (userid: string, over: Record<string, unknown> = {}) => ({ userid, realm: "pve", realmType: "pve", name: userid.split("@")[0], email: null, enabled: true, expire: null, groups: [], comment: null, deviceRole: "none", orgs: [], hasEngineAccount: true, ...over });

beforeEach(() => {
  calls = [];
  canManage = true;
  overview = {
    users: [user("sam@pve", { name: "Sam", deviceRole: "admin", orgs: [{ companyId: "c1", role: "owner" }] }), user("lee@pve", { deviceRole: "operator" }), user("odd@pve", { deviceRole: "custom" })],
    orgs: [{ companyId: "c1", name: "Northwind", pool: "epc-northwind" }, { companyId: "c2", name: "Lumen", pool: null }],
    realms: [{ realm: "pve", type: "pve" }], groups: [], warnings: [],
  };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/api/iac") return new Response(JSON.stringify({ ...overview, canManageUsers: canManage }), { status: 200 });
    if (method === "POST" && url.pathname === "/api/iac/users") return new Response(JSON.stringify({ userid: body.userid, warnings: ["Organization c2: no resource group"] }), { status: 200 });
    if (method === "PUT" && url.pathname.startsWith("/api/iac/users/")) return new Response(JSON.stringify({ userid: "x", warnings: [] }), { status: 200 });
    if (method === "DELETE") return new Response(JSON.stringify({ userid: "lee@pve", warnings: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LiveAccess /></QueryClientProvider>);

describe("the live access screen", () => {
  it("lists real Proxmox users with their device access and organizations", async () => {
    page();
    await screen.findByText("sam@pve");
    expect(screen.getByText("Administrator")).toBeTruthy();
    expect(screen.getByText("Operator")).toBeTruthy();
    expect(screen.getByText(/Custom \(set in Proxmox\)/)).toBeTruthy();
    expect(screen.getByText("Northwind · owner")).toBeTruthy();
    expect(screen.queryByText(/Demo/i)).toBeNull();
  });

  it("is read-only when Proxmox won't let this person manage users", async () => {
    canManage = false;
    page();
    await screen.findByText("sam@pve");
    expect(screen.getByText(/can't manage users/)).toBeTruthy();
    expect(screen.queryByText("New user")).toBeNull();
  });

  it("creates a user with a device role and organization access in one go, and shows what couldn't be done", async () => {
    page();
    await screen.findByText("sam@pve");
    fireEvent.click(screen.getByText("New user"));
    fireEvent.change(await screen.findByPlaceholderText("sam@pve"), { target: { value: "kai@pve" } });
    const pw = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "longenough" } });
    fireEvent.change(screen.getByLabelText("Role in Northwind"), { target: { value: "operator" } });
    fireEvent.change(screen.getByDisplayValue("No device access"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByText("Create user"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/iac/users")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ userid: "kai@pve", password: "longenough", deviceRole: "viewer", orgs: [{ companyId: "c1", role: "operator" }] });
    await screen.findByText(/no resource group/);
  });

  it("won't create a user with a bad name or a short password", async () => {
    page();
    await screen.findByText("sam@pve");
    fireEvent.click(screen.getByText("New user"));
    const btn = (await screen.findByText("Create user")).closest("button")!;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("sam@pve"), { target: { value: "nope" } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: "longenough" } });
    expect(btn.disabled).toBe(true);
  });

  it("saves changes to an existing user, keeping a custom device role untouched", async () => {
    page();
    fireEvent.click(await screen.findByText("odd@pve"));
    await screen.findByText("Save changes");
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/api/iac/users/odd%40pve");
    expect(put.body).not.toHaveProperty("deviceRole");
  });

  it("deletes only after the user's name is typed", async () => {
    page();
    fireEvent.click(await screen.findByText("lee@pve"));
    fireEvent.click(await screen.findByText("Delete user"));
    const del = within(document.body).getAllByText("Delete").map((e) => e.closest("button")!).find(Boolean)!;
    expect(del.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Type lee@pve to confirm"), { target: { value: "lee@pve" } });
    expect(del.disabled).toBe(false);
    fireEvent.click(del);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/iac/users/lee%40pve")).toBe(true));
  });
});

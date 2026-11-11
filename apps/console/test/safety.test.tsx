// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/data/store.tsx", async (orig) => ({ ...(await orig<typeof import("../src/data/store.tsx")>()), useEngine: () => ({ live: true }) }));

import { Safety } from "../src/pages/Safety.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let db: { canManage: boolean; killSwitch: any };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  calls = [];
  db = { canManage: true, killSwitch: null };
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const p = new URL(input, "http://pve.lan").pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: p, body });
    if (p === "/api/safety") return json({ canManage: db.canManage, killSwitch: db.killSwitch, vault: db.canManage ? { keyId: "abcd1234abcd1234" } : null });
    if (p === "/api/safety/kill-switch") {
      db.killSwitch = { on: true, at: 1, by: "sam@pve", stopped: [{ vmid: 301, name: "agent-a" }], paused: [{ companyId: "c", agentId: "a" }], failures: ["CT 9: boom"], unreachableOrganizations: 1 };
      return json({ killSwitch: db.killSwitch });
    }
    if (p === "/api/safety/resume") { db.killSwitch = { ...db.killSwitch, on: false }; return json({ killSwitch: db.killSwitch, resumedAgents: 1, failures: [] }); }
    if (p === "/api/vault/recovery/export") return json({ v: 1, kind: "epaperclip-vault-key", kid: "abcd1234abcd1234", created: "2026-11-11T00:00:00Z" });
    return json({ error: "not found" }, 404);
  });
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Safety /></QueryClientProvider>);

describe("Settings → Safety", () => {
  it("shows people who aren't administrators only a notice", async () => {
    db.canManage = false;
    renderPage();
    expect(await screen.findByText(/Only Proxmox administrators/)).toBeTruthy();
    expect(screen.queryByText("Stop everything…")).toBeNull();
  });

  it("makes the person type the phrase before the kill switch works, then says what it did", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Stop everything…" }));
    const go = await screen.findByRole("button", { name: "Stop everything" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "STOP EVERYTHING" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Stop everything" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Stop everything" }));
    await screen.findByText("What the switch did");
    expect(calls.find((c) => c.path === "/api/safety/kill-switch")?.body).toEqual({ confirm: "STOP EVERYTHING" });
    expect(screen.getByText(/1 container stopped, 1 agent paused, by sam@pve/)).toBeTruthy();
    expect(screen.getByText(/1 organization couldn't be reached/)).toBeTruthy();
    expect(screen.getByText("CT 9: boom")).toBeTruthy();
    // Clearing it says plainly that nothing was restarted.
    fireEvent.click(screen.getByRole("button", { name: "Clear the kill switch" }));
    await screen.findByText(/no containers were started/);
    expect(calls.find((c) => c.path === "/api/safety/resume")?.body).toEqual({ unpauseAgents: true });
  });

  it("downloads a recovery file only for a long passphrase typed twice", async () => {
    renderPage();
    const pass = await screen.findByLabelText("Recovery passphrase");
    const again = screen.getByLabelText("Again");
    const btn = () => screen.getByRole("button", { name: /Download recovery file/ }) as HTMLButtonElement;
    const off = () => btn().disabled || btn().getAttribute("aria-disabled") === "true";
    expect(off()).toBe(true);
    fireEvent.change(pass, { target: { value: "short" } });
    fireEvent.change(again, { target: { value: "short" } });
    expect(off()).toBe(true);
    fireEvent.change(pass, { target: { value: "correct horse battery" } });
    fireEvent.change(again, { target: { value: "different words here" } });
    expect(await screen.findByText("The passphrases differ.")).toBeTruthy();
    expect(off()).toBe(true);
    fireEvent.change(again, { target: { value: "correct horse battery" } });
    await waitFor(() => expect(off()).toBe(false));
    fireEvent.click(btn());
    await screen.findByText(/Recovery file downloaded/);
    expect(calls.find((c) => c.path === "/api/vault/recovery/export")?.body).toEqual({ passphrase: "correct horse battery" });
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});

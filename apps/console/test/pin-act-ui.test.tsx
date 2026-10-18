// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { normalizeSettings, pinApi, toStreamEvent } from "../src/pin/live.ts";

const decide = vi.fn();
vi.mock("../src/data/engine/pinRuntimeApi.ts", () => ({ pinRt: { decide: (...a: unknown[]) => decide(...a) } }));
const setPermission = vi.fn();
let permission: "ask" | "bypass" = "ask";
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: true, setup: { deviceName: "pve" } }) }));
vi.mock("../src/pin/PinContext.tsx", () => ({ usePin: () => ({ settings: { provider: "anthropic", model: "m", mode: "agent", permission, connectors: [] }, setPermission }) }));

import { ToolCard } from "../src/pin/PinCards.tsx";
import { PermissionPicker } from "../src/pin/PermissionPicker.tsx";

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
beforeEach(() => {
  decide.mockReset();
  setPermission.mockReset();
  permission = "ask";
});
afterEach(cleanup);

describe("the stream tells the chat what Pin is doing", () => {
  it("turns approval, running and finished events into one card's states", () => {
    const approval = toStreamEvent({ event: "approval", data: JSON.stringify({ id: "tu0", name: "delete_machine", planId: "p1", stepId: "s1", label: "Delete machine 101", destructive: true, confirmPhrase: "destroy 101" }) });
    expect(approval).toMatchObject({ type: "tool", tool: { id: "tu0", status: "approval", planId: "p1", stepId: "s1", destructive: true, confirmPhrase: "destroy 101" } });
    expect(toStreamEvent({ event: "tool", data: JSON.stringify({ id: "tu0", name: "create_container", status: "running", label: "Create container media" }) })).toMatchObject({ tool: { status: "running", label: "Create container media" } });
    expect(toStreamEvent({ event: "tool", data: JSON.stringify({ id: "tu0", name: "create_container", status: "done", label: "Create container media", result: "Created.", vmid: 300 }) })).toMatchObject({ tool: { status: "done", result: "Created.", vmid: 300 } });
    expect(toStreamEvent({ event: "approval", data: "{}" })).toBeNull();
  });

  it("settings carry the permission, defaulting to ask, and bypass sends its typed word", async () => {
    expect(normalizeSettings({}).permission).toBe("ask");
    expect(normalizeSettings({ permission: "nonsense" as never }).permission).toBe("ask");
    const sent: unknown[] = [];
    const f = (async (_p: unknown, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), new Response(JSON.stringify({ provider: null, model: null, mode: "agent", permission: "bypass", connectors: [] }), { headers: { "content-type": "application/json" } }))) as typeof fetch;
    const saved = await pinApi(f).saveSettings(normalizeSettings({ mode: "agent" }), { confirmBypass: "bypass" });
    expect(saved.permission).toBe("bypass");
    expect(sent[0]).toMatchObject({ mode: "agent", confirmBypass: "bypass" });
  });
});

describe("approving in the chat", () => {
  const card = (o: Record<string, unknown> = {}) => <ToolCard messageId="m1" tool={{ id: "tu0", name: "create_container", args: {}, status: "approval", label: "Create container “media” from debian-12", planId: "p1", stepId: "s1", destructive: false, confirmPhrase: null, ...o } as never} />;

  it("approves with one click when nothing is lost by it", async () => {
    decide.mockResolvedValue({});
    wrap(card());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("p1", "s1", "approve", undefined));
    expect(await screen.findByText(/Approved. Running/)).toBeTruthy();
  });

  it("declines without running anything", async () => {
    decide.mockResolvedValue({});
    wrap(card());
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("p1", "s1", "reject", undefined));
    expect(await screen.findByText(/Declined. Nothing changed/)).toBeTruthy();
  });

  it("makes you type the phrase before something that can't be undone", async () => {
    decide.mockResolvedValue({});
    wrap(card({ name: "delete_machine", label: "Delete machine 101 (web) and its disks", destructive: true, confirmPhrase: "destroy 101" }));
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("destroy 101"), { target: { value: "destroy 101" } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(decide).toHaveBeenCalledWith("p1", "s1", "approve", "destroy 101"));
  });

  it("shows why it didn't go through", async () => {
    decide.mockRejectedValue(new Error("Plans are approved in the console, by a signed-in person."));
    wrap(card());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/signed-in person/);
  });

  it("shows progress and the outcome of what Pin did", () => {
    wrap(<><ToolCard messageId="m" tool={{ id: "a", name: "create_vm", args: {}, status: "running", label: "Create virtual machine lab" } as never} /><ToolCard messageId="m" tool={{ id: "b", name: "power_machine", args: {}, status: "done", label: "Start machine 101", result: "Started web (101)." } as never} /><ToolCard messageId="m" tool={{ id: "c", name: "delete_machine", args: {}, status: "failed", label: "Delete machine 5", error: "It is running. Shut it down first." } as never} /></>);
    expect(screen.getByText(/Create virtual machine lab…/)).toBeTruthy();
    expect(screen.getByText("Started web (101).")).toBeTruthy();
    expect(screen.getByText(/Shut it down first/)).toBeTruthy();
  });
});

describe("the permission picker", () => {
  it("changes the permission, and bypass asks for the typed word first", async () => {
    setPermission.mockResolvedValue(undefined);
    wrap(<PermissionPicker />);
    fireEvent.change(screen.getByLabelText(/What Pin may do on its own/), { target: { value: "accept" } });
    await waitFor(() => expect(setPermission).toHaveBeenCalledWith("accept"));
    setPermission.mockClear();
    fireEvent.change(screen.getByLabelText(/What Pin may do on its own/), { target: { value: "bypass" } });
    expect(setPermission).not.toHaveBeenCalled();
    const go = await screen.findByRole("button", { name: "Turn on bypass" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type bypass to confirm"), { target: { value: "bypass" } });
    fireEvent.click(go);
    await waitFor(() => expect(setPermission).toHaveBeenCalledWith("bypass", "bypass"));
  });

  it("explains the choice in words and warns about bypass", () => {
    permission = "bypass";
    wrap(<PermissionPicker />);
    expect(screen.getByText(/no questions, deletes included/)).toBeTruthy();
  });
});

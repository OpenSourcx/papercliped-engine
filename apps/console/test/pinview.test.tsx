// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationList, type ConversationItem } from "../src/pin/ConversationList.tsx";

afterEach(cleanup);
const NOW = Date.now();
const items: ConversationItem[] = [
  { key: "pin:1", source: "pin", title: "Fix the backup job", context: "Pin", updatedAt: NOW - 1000 },
  { key: "agent:c1:a1", source: "agent", title: "CEO", context: "Acme", updatedAt: NOW - 3 * 86_400_000 },
  { key: "pin:2", source: "pin", title: "Storage layout", context: "Pin", updatedAt: NOW - 30 * 86_400_000 },
];
const list = (extra: Partial<Parameters<typeof ConversationList>[0]> = {}) => render(<ConversationList items={items} activeKey="pin:1" onPick={() => undefined} {...extra} />);

describe("ConversationList", () => {
  it("sorts newest first and groups by day", () => {
    list({ grouped: true });
    expect(screen.getAllByText(/^(Today|This week|Earlier)$/).map((e) => e.textContent)).toEqual(["Today", "This week", "Earlier"]);
    expect(screen.getAllByRole("button").map((b) => b.textContent).join("|")).toMatch(/Fix the backup job.*CEO.*Storage layout/);
  });

  it("searches titles and organizations, and filters by who the chat is with", () => {
    list({ search: true, filter: true });
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "acme" } });
    expect(screen.getByText("CEO")).toBeTruthy();
    expect(screen.queryByText("Storage layout")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "Agents" }));
    expect(screen.queryByText("Storage layout")).toBeNull();
    expect(screen.getByText("CEO")).toBeTruthy();
  });

  it("offers rename and delete only when the owner of the list gives handlers", () => {
    const { unmount } = list();
    expect(screen.queryByLabelText("Rename Storage layout")).toBeNull();
    unmount();
    list({ onRename: async () => undefined, onDelete: async () => undefined });
    expect(screen.getByLabelText("Rename Storage layout")).toBeTruthy();
    expect(screen.getByLabelText("Delete Storage layout")).toBeTruthy();
  });

  it("marks the open conversation", () => {
    list();
    expect(screen.getByText("Fix the backup job").closest("button")?.getAttribute("aria-current")).toBe("true");
  });
});

vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: false, setup: { deviceName: "pve" }, data: { orgs: [] } }) }));
vi.mock("../src/pin/PinContext.tsx", () => ({
  usePin: () => ({ chats: [{ id: "x", title: "Saved one", createdAt: 1, updatedAt: NOW, count: 2 }], chatId: null, messages: [], thinking: false, streaming: false, settings: null, providerName: null, newChat: () => undefined, openChat: async () => undefined, renameChat: async () => undefined, deleteChat: async () => undefined, send: () => undefined, stop: () => undefined, markDone: () => undefined, resolveTool: () => undefined }),
}));

describe("PinView", () => {
  it("lists Pin's chats beside the thread and offers a way back", async () => {
    const { PinView } = await import("../src/pages/pinview/PinView.tsx");
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><PinView /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole("region", { name: "PinView" })).toBeTruthy();
    expect(screen.getByText("Saved one")).toBeTruthy();
    expect(screen.getByLabelText("Back to the console").getAttribute("href")).toBe("/pve/home");
    expect(screen.getByLabelText("Message Pin")).toBeTruthy();
  });
});

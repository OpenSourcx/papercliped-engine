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
    expect(screen.queryByLabelText("Options for Storage layout")).toBeNull();
    unmount();
    list({ onRename: async () => undefined, onDelete: async () => undefined });
    fireEvent.click(screen.getByLabelText("Options for Storage layout"));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Keep it"));
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
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

describe("PinView panels", () => {
  it("opens Files as a tile and Details beside it, and closes them", async () => {
    const { PinView } = await import("../src/pages/pinview/PinView.tsx");
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><PinView /></MemoryRouter></QueryClientProvider>);
    expect(screen.queryByRole("complementary", { name: "Tiles" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Files" })[0]!);
    expect(screen.getByRole("complementary", { name: "Tiles" })).toBeTruthy();
    expect(screen.getByText("No organizations yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Model" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Close Files"));
    expect(screen.queryByRole("complementary", { name: "Tiles" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Close details"));
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
  });

  it("hides and restores detail cards from the Show menu", async () => {
    localStorage.clear();
    const { PinView } = await import("../src/pages/pinview/PinView.tsx");
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><PinView /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Show cards" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Model" }));
    expect(screen.queryByRole("region", { name: "Model" })).toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: "Model" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset to defaults" }));
    expect(screen.getByRole("region", { name: "Model" })).toBeTruthy();
  });
});

describe("ConversationList sections", () => {
  const sections = [
    { id: "pinned", label: "Pinned", items: [items[1]!] },
    { id: "pin", label: "Pin", items: [items[0]!, items[2]!] },
    { id: "c1", label: "Acme", items: [] },
  ];

  it("shows named sections, folds one away, and says when a section is empty", () => {
    render(<ConversationList sections={sections} activeKey={null} onPick={() => undefined} />);
    expect(screen.getByRole("button", { name: /Pinned/ })).toBeTruthy();
    expect(screen.getByText("No chats yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Pin$/ }));
    expect(screen.queryByText("Storage layout")).toBeNull();
    expect(screen.getByText("CEO")).toBeTruthy();
  });

  it("pins and unpins from a row", () => {
    const toggled: string[] = [];
    render(<ConversationList sections={sections} pinned={new Set(["agent:c1:a1"])} onTogglePin={(c) => toggled.push(c.key)} activeKey={null} onPick={() => undefined} />);
    fireEvent.click(screen.getByLabelText("Options for CEO"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    fireEvent.click(screen.getByLabelText("Options for Storage layout"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(toggled).toEqual(["agent:c1:a1", "pin:2"]);
  });

  it("search opens folded sections and hides empty ones", () => {
    render(<ConversationList sections={sections} search activeKey={null} onPick={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "backup" } });
    expect(screen.getByText("Fix the backup job")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Acme/ })).toBeNull();
  });
});

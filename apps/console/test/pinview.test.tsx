// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: false, setup: { deviceName: "pve" }, data: { orgs: [], guests: [] }, host: { ip: "10.0.0.2", cpus: 4, memUsed: 1, memTotal: 2, diskTotal: 3 } }) }));
const pinState = { messages: [] as unknown[], chats: [{ id: "x", title: "Saved one", createdAt: 1, updatedAt: NOW, count: 2 }] as unknown[] };
vi.mock("../src/pin/PinContext.tsx", () => ({
  usePin: () => ({ chats: pinState.chats, chatId: null, messages: pinState.messages, thinking: false, streaming: false, settings: null, providerName: null, newChat: () => undefined, openChat: async () => undefined, renameChat: async () => undefined, deleteChat: async () => undefined, send: () => undefined, stop: () => undefined, markDone: () => undefined, resolveTool: () => undefined }),
}));

const workspace = async () => {
  const { PinView } = await import("../src/pages/pinview/PinView.tsx");
  return render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><PinView /></MemoryRouter></QueryClientProvider>);
};

describe("PinView workspace", () => {
  beforeEach(() => { localStorage.clear(); pinState.messages = []; pinState.chats = [{ id: "x", title: "Saved one", createdAt: 1, updatedAt: NOW, count: 2 }]; });

  it("shows the activity bar, the conversations, the conversation and a status bar", async () => {
    await workspace();
    expect(screen.getByRole("region", { name: "PinView" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByText("Saved one")).toBeTruthy();
    expect(screen.getByLabelText("Message Pin")).toBeTruthy();
    expect(screen.getByRole("contentinfo", { name: "Status" })).toBeTruthy();
  });

  it("switches side views from the activity bar, and hides the side panel when the open one is pressed again", async () => {
    await workspace();
    const bar = within(screen.getByRole("navigation", { name: "Workspace" }));
    fireEvent.click(bar.getByRole("button", { name: "Explorer" }));
    expect(screen.getByText(/a machine's folders and files appear here/)).toBeTruthy();
    fireEvent.click(bar.getByRole("button", { name: "Explorer" }));
    // Closed on a wide screen (it stays as the list on a phone, where the conversation opens over it).
    expect(screen.getByRole("complementary", { name: "Side panel" }).className).toContain("md:hidden");
    fireEvent.click(bar.getByRole("button", { name: /^Conversations/ }));
    expect(screen.getByText("Saved one")).toBeTruthy();
  });

  it("toggles the details and the panel with the keyboard, and hides detail cards from the Show menu", async () => {
    await workspace();
    fireEvent.keyDown(window, { key: ".", ctrlKey: true });
    expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show cards" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Model" }));
    expect(screen.queryByRole("region", { name: "Model" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset to defaults" }));
    expect(screen.getByRole("region", { name: "Model" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(screen.getByRole("region", { name: "Panel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Steps/ }));
    expect(screen.getByText(/Pin's steps in this conversation appear here/)).toBeTruthy();
  });

  it("goes to anything from the palette (Ctrl+P)", async () => {
    await workspace();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Go to" });
    fireEvent.change(box, { target: { value: "explorer" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/a machine's folders and files appear here/)).toBeTruthy();
  });

  it("opens the file Pin read as a preview tab beside the conversation, and keeps it when double-clicked", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    pinState.messages = [{ id: "m1", from: "pin", text: "", tool: { id: "t1", name: "machine_read_file", args: { vmid: 103, path: "/etc/hosts" }, status: "done", result: "Exit 0. In paperclip (103).\n127.0.0.1 localhost" } }];
    await workspace();
    const tab = await screen.findByRole("tab", { name: /hosts/ });
    expect(tab.textContent).toContain("(preview)");
    expect(screen.getByText("127.0.0.1 localhost")).toBeTruthy();
    fireEvent.doubleClick(tab);
    expect(screen.getByRole("tab", { name: /hosts/ }).textContent).not.toContain("(preview)");
    fireEvent.click(screen.getByLabelText("Close hosts"));
    expect(screen.queryByRole("tab", { name: /hosts/ })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("marks a chat that changed after your first visit as unread, filters to unread from the menu, and marks all read", async () => {
    pinState.chats = [{ id: "x", title: "Saved one", createdAt: 1, updatedAt: NOW, count: 2 }, { id: "y", title: "Fresh one", createdAt: 1, updatedAt: Date.now() + 60_000, count: 1 }];
    await workspace();
    expect(screen.getAllByText("(unread)")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Unread/ }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByText("Saved one")).toBeNull();
    expect(screen.getByText(/Showing unread/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show all conversations"));
    fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all as read" }));
    expect(screen.queryByText("(unread)")).toBeNull();
  });
});

describe("ConversationList sections", () => {
  const sections = [
    { id: "pinned", label: "Pinned", items: [items[1]!] },
    { id: "pin", label: "Pin", items: [items[0]!, items[2]!] },
    { id: "c1", label: "Acme", items: [], empty: "No chats yet." },
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


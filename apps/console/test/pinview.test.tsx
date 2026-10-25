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
  beforeEach(() => {
    localStorage.clear();
    pinState.messages = [];
    pinState.chats = [{ id: "x", title: "Saved one", createdAt: 1, updatedAt: NOW, count: 2 }];
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("has the sidebar's places and groups, the conversation and its toolbar", async () => {
    await workspace();
    const side = within(screen.getByRole("navigation", { name: "Conversations" }));
    for (const n of ["New chat", "Search", "Artifacts", "Machine files", "Pull requests"]) expect(side.getByRole("button", { name: n })).toBeTruthy();
    expect(side.getByRole("region", { name: "Recents" })).toBeTruthy();
    expect(side.getByText("Saved one")).toBeTruthy();
    expect(screen.getByLabelText("Message Pin")).toBeTruthy();
    for (const n of ["Cards (Ctrl+.)", "Plan", "Terminal", "Files"]) expect(screen.getByRole("button", { name: n }).getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles tiles from the toolbar icons, stacks them, and closes one from its header", async () => {
    await workspace();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const tiles = screen.getByRole("complementary", { name: "Tiles" });
    expect(within(tiles).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Files", "Plan"]);
    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Close Plan"));
    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByLabelText("Expand Files"));
    expect(screen.getByLabelText("Restore Files")).toBeTruthy();
  });

  it("shows the cards with Ctrl+. and hides one from the Show menu", async () => {
    await workspace();
    fireEvent.keyDown(window, { key: ".", ctrlKey: true });
    const cards = within(screen.getByRole("complementary", { name: "Cards" }));
    for (const n of ["Environment", "Context", "Connectors", "Changes", "Background tasks"]) expect(cards.getByRole("region", { name: n })).toBeTruthy();
    fireEvent.click(cards.getByRole("button", { name: "Show cards" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Context" }));
    expect(cards.queryByRole("region", { name: "Context" })).toBeNull();
  });

  it("lists Pin's steps as tasks in the plan, and opens the file it read as a preview tab", async () => {
    pinState.messages = [
      { id: "m1", from: "pin", text: "", tool: { id: "t1", name: "machine_read_file", label: "Read /etc/hosts in machine 103", args: { vmid: 103, path: "/etc/hosts" }, status: "done", result: "Exit 0. In paperclip (103).\n127.0.0.1 localhost" } },
      { id: "m2", from: "pin", text: "", tool: { id: "t2", name: "machine_exec", label: "Run apt update", args: { vmid: 103, command: "apt update" }, status: "running" } },
    ];
    await workspace();
    const tab = await screen.findByRole("tab", { name: /apt update/ });
    expect(tab.textContent).toContain("(preview)");
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    const plan = within(screen.getByRole("region", { name: "Plan" }));
    expect(plan.getByText("Read /etc/hosts in machine 103").className).toContain("line-through");
    fireEvent.click(plan.getByText("Read /etc/hosts in machine 103"));
    expect(await screen.findByText("127.0.0.1 localhost")).toBeTruthy();
  });

  it("renames a chat from its row menu, marks a group read, and searches from the palette", async () => {
    pinState.chats = [{ id: "x", title: "Saved one", createdAt: 1, updatedAt: NOW, count: 2 }, { id: "y", title: "Fresh one", createdAt: 1, updatedAt: Date.now() + 60_000, count: 1 }];
    await workspace();
    expect(screen.getByLabelText("1 unread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recents options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
    expect(screen.queryByLabelText("1 unread")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Options for Saved one" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByLabelText("Chat name")).toBeTruthy();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const box = await screen.findByRole("combobox", { name: "Go to" });
    fireEvent.change(box, { target: { value: "terminal" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Terminal" }).getAttribute("aria-pressed")).toBe("true");
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


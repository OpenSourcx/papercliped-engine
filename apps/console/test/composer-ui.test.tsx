// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PinInput } from "../src/pin/PinThread.tsx";
import { ThreadProvider, type ThreadApi } from "../src/pin/ThreadContext.tsx";

/**
 * The composer as the person meets it: "/" and "@" from the keyboard alone, "#" saved to memory, and the line under the
 * field. `PinInput` falls back to Pin's own context, so these stubs stand in for it.
 */

const send = vi.fn();
const remember = vi.fn();
const restore = vi.fn();
const setMode = vi.fn();
const setPermission = vi.fn();
const setSettings = vi.fn();

vi.mock("../src/pin/PinContext.tsx", () => ({
  usePin: () => ({
    name: "Pin",
    settings: { provider: "anthropic", model: "a-model", mode: "agent", permission: "ask", connectors: [] },
    settingsSource: { models: async () => [{ id: "a-model", name: "A model" }, { id: "b-model", name: "B model" }], save: async (s: unknown) => s },
    setMode,
    setPermission,
    setSettings,
    newChat: vi.fn(),
    pin: undefined,
  }),
}));

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({
    live: true,
    setup: { deviceName: "pve" },
    pin: { memory: "", soul: "" },
    savePinFile: vi.fn(),
    data: {
      orgs: [
        {
          slug: "acme",
          name: "Acme",
          agents: [{ id: "a1", name: "Ops lead", role: "Operator" }],
          projects: [{ id: "p1", name: "Website" }],
        },
      ],
      users: [{ id: "u1", name: "Sam", email: "sam@example.test", pveUser: "sam@pve", role: "owner" }],
      guests: [{ vmid: 101, name: "discord-bot", type: "lxc", status: "running" }],
    },
  }),
}));

// Live, people come from Proxmox's users through this query.
vi.mock("../src/pages/access/shared.tsx", () => ({
  useIac: () => ({
    data: {
      users: [
        { userid: "sam@pve", name: "Sam", realm: "pve", groups: [], deviceRole: "custom", orgs: [] },
        { userid: "ana@pve", name: "Ana", realm: "pve", groups: [], deviceRole: "custom", orgs: [] },
      ],
      orgs: [],
      realms: [],
      groups: [],
    },
  }),
}));

vi.mock("../src/data/engine/pinLibraryApi.ts", () => ({
  pinLibrary: {
    remember: (text: string) => remember(text),
    restore: (rev: number) => restore(rev),
  },
}));

const thread: ThreadApi = { messages: [], thinking: false, streaming: false, send, stop: vi.fn(), markDone: vi.fn(), resolveTool: vi.fn(), name: "Pin" };

function composer(shell?: Parameters<typeof PinInput>[0]["workspace"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ThreadProvider value={thread}>
          <PinInput workspace={shell} />
        </ThreadProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The field is a combobox when it can open a list, which is how a screen reader follows the choices.
const field = () => screen.getByRole("combobox", { name: /Message Pin/ }) as HTMLTextAreaElement;

beforeEach(() => {
  send.mockReset();
  remember.mockReset().mockResolvedValue({ ok: true, message: "Saved to MEMORY.md: focus on work", line: "- 2026-10-28: focus on work", rev: 7 });
  restore.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe("the composer's commands", () => {
  it("opens on / and runs the highlighted command with Enter, from the keyboard alone", () => {
    composer();
    fireEvent.change(field(), { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    // Filter to one, then Enter runs it.
    fireEvent.change(field(), { target: { value: "/mode" } });
    // The name match comes first, so Enter runs /mode even though other rows mention "mode" in their words.
    expect(screen.getAllByRole("option")[0].textContent).toContain("/mode");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(setMode).toHaveBeenCalledWith("assistant");
    // The field is empty again and the list is gone.
    expect(field().value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
    // Nothing was sent as a chat message.
    expect(send).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys and closes with Escape, leaving the text as typed", () => {
    composer();
    fireEvent.change(field(), { target: { value: "/" } });
    const first = screen.getAllByRole("option")[0];
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().value).toBe("/");
  });

  it("opens a workspace tile when the composer is in PinView", () => {
    const openTile = vi.fn();
    composer({ newChat: vi.fn(), openTile, org: "acme" });
    fireEvent.change(field(), { target: { value: "/terminal" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(openTile).toHaveBeenCalledWith("terminal");
  });
});

describe("the composer's mentions", () => {
  it("groups the choices, starts with the open organization, and turns a choice into a chip's text", () => {
    composer({ newChat: vi.fn(), openTile: vi.fn(), org: "acme" });
    fireEvent.change(field(), { target: { value: "ask @ops" } });
    const list = screen.getByRole("listbox", { name: "Mention" });
    expect(list).toBeTruthy();
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.textContent).join(" ")).toContain("Ops lead");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("ask @Ops-lead ");
  });

  it("sends the mention's id with the message, never its name", () => {
    composer();
    fireEvent.change(field(), { target: { value: "what is @disc" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("what is @discord-bot ");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("what is @discord-bot", { context: { mentions: [{ kind: "machine", id: "101" }] } });
  });

  it("keeps a mention that is the whole message, even though the message is trimmed", () => {
    composer();
    fireEvent.change(field(), { target: { value: "@dis" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    // The field is "@discord-bot " with a trailing space; the message sent is trimmed.
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("@discord-bot", { context: { mentions: [{ kind: "machine", id: "101" }] } });
  });

  it("does not carry a mention the person deleted from the text", () => {
    composer();
    fireEvent.change(field(), { target: { value: "@dis" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.change(field(), { target: { value: "never mind" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("never mind", {});
  });

  it("Tab completes the highlighted mention without sending", () => {
    composer();
    fireEvent.change(field(), { target: { value: "@sam" } });
    // "sam@pve" is the only person whose name, id or detail matches.
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(field().value).toBe("@sam@pve ");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the composer's memory line", () => {
  it("saves a # line to memory instead of sending it, and offers Undo", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "# we need to focus on work" } });
    // A memory line never opens the mention picker.
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(remember).toHaveBeenCalledWith("we need to focus on work"));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Saved to MEMORY.md");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(7));
    expect(field().value).toBe("");
  });

  it("says what is missing when nothing follows the #", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "#" } });
    expect(screen.getByText(/Type what to remember after the #/)).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(remember).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the composer's status line", () => {
  it("shows the mode, what Pin may do and the model, and changes the mode from a menu", () => {
    composer();
    const mode = screen.getByRole("button", { name: /Mode: Agent mode/ });
    expect(screen.getByRole("button", { name: /Permission: Ask/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Model: a-model/ })).toBeTruthy();
    fireEvent.click(mode);
    fireEvent.click(screen.getByRole("menuitem", { name: /Assistant/ }));
    expect(setMode).toHaveBeenCalledWith("assistant");
  });

  it("reads the models from the provider before offering them", async () => {
    composer();
    fireEvent.click(screen.getByRole("button", { name: /Model: a-model/ }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /B model/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: /B model/ }));
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ model: "b-model" }));
  });
});

describe("quoting into the composer", () => {
  it("puts a quoted message above what is already typed, as it always did", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "my own words" } });
    window.dispatchEvent(new CustomEvent("pin:quote", { detail: "the thing Pin said" }));
    await waitFor(() => expect(field().value).toBe("> the thing Pin said\n\nmy own words"));
  });
});

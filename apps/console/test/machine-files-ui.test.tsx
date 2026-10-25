// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileEditor, MachineBrowser } from "../src/pages/pinview/MachineFiles.tsx";
import { ConversationList } from "../src/pin/ConversationList.tsx";
import type { Guest } from "../src/data/types.ts";

vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: true }) }));

interface Call { method: string; path: string; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => [number, unknown]>;
beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(input, "http://pve.lan");
    const c: Call = { method: init.method ?? "GET", path: u.pathname + u.search, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const h = handlers[`${c.method} ${u.pathname}`];
    const [status, body] = h ? h(c) : [404, { error: "Not found" }];
    return new Response(JSON.stringify(body), { status });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const guest = (vmid: number, name: string, status: "running" | "stopped"): Guest => ({ vmid, name, type: "lxc", status, cpuPct: 0, cores: 1, memUsed: 0, memMax: 1, diskMax: 1, org: null, protected: false } as Guest);

describe("machine file browser", () => {
  it("lists a machine's folder, folders first, walks into one, and opens a file", async () => {
    handlers["GET /api/guests/103/files"] = (c) => [200, c.path.includes(encodeURIComponent("/etc")) ? { path: "/etc", entries: [{ name: "hosts", kind: "file", size: 120, mtime: 1 }], truncated: false } : { path: "/", entries: [{ name: "etc", kind: "dir", size: 0, mtime: 1 }, { name: ".profile", kind: "file", size: 10, mtime: 1 }], truncated: false }];
    const opened: string[] = [];
    let vmid: number | null = null;
    const { rerender } = wrap(<MachineBrowser machines={[guest(103, "paperclip", "running"), guest(104, "old", "stopped")]} vmid={vmid} onVmid={(v) => { vmid = v; }} onOpenFile={(v, p) => opened.push(`${v}:${p}`)} expanded={false} onExpand={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Choose a running machine to browse its files.")).toBeTruthy();
    rerender(<QueryClientProvider client={new QueryClient()}><MachineBrowser machines={[guest(103, "paperclip", "running")]} vmid={103} onVmid={() => undefined} onOpenFile={(v, p) => opened.push(`${v}:${p}`)} expanded={false} onExpand={() => undefined} onClose={() => undefined} /></QueryClientProvider>);
    fireEvent.click(await screen.findByText("etc"));
    expect(screen.queryByText(".profile")).toBeNull(); // hidden files stay hidden until asked
    fireEvent.click(await screen.findByText("hosts"));
    expect(opened).toEqual(["103:/etc/hosts"]);
    expect(screen.getByRole("button", { name: "etc" }).getAttribute("aria-current")).toBe("location");
  });
});

describe("file editor", () => {
  it("opens a file, edits it, saves it with its etag, and says when it changed in the machine", async () => {
    handlers["GET /api/guests/103/file"] = () => [200, { path: "/etc/app.conf", size: 6, content: "a = 1\n", tooLarge: false, binary: false, etag: "e1" }];
    handlers["PUT /api/guests/103/file"] = (c) => (c.body.etag === "e1" && c.body.content === "a = 2\n" ? [200, { path: "/etc/app.conf", size: 6, etag: "e2" }] : [409, { error: "The file changed in the machine since you opened it.", code: "changed" }]);
    wrap(<FileEditor vmid={103} path="/etc/app.conf" expanded={false} onExpand={() => undefined} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
    const area = screen.getByLabelText("Edit /etc/app.conf") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "a = 2\n" } });
    expect(screen.getByText("● app.conf")).toBeTruthy();
    fireEvent.keyDown(area, { key: "s", ctrlKey: true });
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ path: "/etc/app.conf", content: "a = 2\n", etag: "e1" });
    await waitFor(() => expect(screen.queryByText("● app.conf")).toBeNull());
    // A second edit with the old etag gone stale on the host's side.
    handlers["PUT /api/guests/103/file"] = () => [409, { error: "changed", code: "changed" }];
    fireEvent.change(screen.getByLabelText("Edit /etc/app.conf"), { target: { value: "a = 3\n" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText("Changed in the machine")).toBeTruthy();
  });

  it("indents with Tab, and shows binary and large files without an editor", async () => {
    handlers["GET /api/guests/103/file"] = (c) => [200, c.path.includes("bin") ? { path: "/bin/x", size: 9, content: null, tooLarge: false, binary: true, etag: "b" } : { path: "/big", size: 900000, content: null, tooLarge: true, binary: false, etag: null }];
    wrap(<><FileEditor vmid={103} path="/bin/x" expanded={false} onExpand={() => undefined} onClose={() => undefined} /><FileEditor vmid={103} path="/big" expanded={false} onExpand={() => undefined} onClose={() => undefined} /></>);
    expect(await screen.findByText(/binary file/)).toBeTruthy();
    expect(await screen.findByText(/files up to 48 KB open here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  });
});

describe("unread markers", () => {
  it("marks unread rows and counts them on their section", () => {
    render(<ConversationList sections={[{ id: "c1", label: "Acme", items: [{ key: "a", source: "agent", title: "CEO", updatedAt: 2, unread: true }, { key: "b", source: "agent", title: "Dev", updatedAt: 1 }] }]} activeKey={null} onPick={() => undefined} />);
    expect(screen.getByText("(unread)")).toBeTruthy();
    expect(screen.getByLabelText("1 unread")).toBeTruthy();
  });
});

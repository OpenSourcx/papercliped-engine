// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live: true, setup: { deviceName: "pve" }, data: { orgs: [] } }) }));

import { Markdown, parseBlocks } from "../src/pages/pin/notes/Markdown.tsx";
import { NotesPage } from "../src/pages/pin/notes/NotesPage.tsx";

interface Call { method: string; path: string; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, body: init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const h = handlers[`${call.method} ${call.path}`];
    return h ? json(h(call)) : json({ error: "Not found" }, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const wrap = (ui: React.ReactElement, at = "/pve/notes") => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[at]}>{ui}</MemoryRouter></QueryClientProvider>);

describe("Markdown", () => {
  it("renders structure but never HTML, images or unsafe links", () => {
    const { container } = render(<Markdown text={'# Title\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [ok](https://pve.proxmox.com/wiki) ![pic](https://evil.test/p.png)\n\n- [x] done\n- [ ] todo\n\n```\n<b>code</b>\n```\n\npw ⟦redacted:password:s1⟧'} />);
    expect(container.querySelector("script,img,iframe")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://pve.proxmox.com/wiki", "https://evil.test/p.png"]); // an image is only ever a link, never loaded
    expect(container.querySelector("a")!.getAttribute("rel")).toContain("noopener");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.querySelector("pre")!.textContent).toBe("<b>code</b>");
    expect(container.textContent).toContain("password removed");
    expect([...container.querySelectorAll("*")].some((e) => e.getAttributeNames().some((a) => a.startsWith("on")))).toBe(false);
    expect(parseBlocks("a\n---\nb").map((b) => b.t)).toEqual(["p", "hr", "p"]);
  });
});

describe("Notes page", () => {
  const list = (notes: unknown[] = []) => ({ notes, total: notes.length, folders: [{ path: "Inbox", count: 1 }, { path: "Runbooks", count: 1 }], tags: [{ tag: "zfs", count: 1 }], settings: { autoFile: false }, limits: { notes: 300, body: 32000, totalBody: 1000000, used: 10 }, batches: [] });
  const row = { id: "a".repeat(16), title: "ZFS scrub", folder: "Runbooks", tags: ["zfs"], pinned: true, links: [{ kind: "machine", id: "101", label: "web #101" }], share: null, hasVault: false, source: "manual", createdAt: 1, updatedAt: Date.now(), snippet: "weekly scrub", mine: true };

  it("lists notes with folders and tags, and searches on the server", async () => {
    handlers["GET /api/notes"] = () => list([row]);
    handlers["GET /api/notes/shared"] = () => ({ notes: [] });
    wrap(<NotesPage />);
    expect(await screen.findByText("ZFS scrub")).toBeTruthy();
    expect(screen.getAllByText("Runbooks").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Search notes"), { target: { value: "scrub" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/notes" && c.method === "GET")).toBe(true));
  });

  it("sorts a pile: shows the review, files nothing until Accept, then offers undo", async () => {
    handlers["GET /api/notes"] = () => list();
    handlers["GET /api/notes/shared"] = () => ({ notes: [] });
    const draft = { id: "d".repeat(16), createdAt: 1, engine: "rules", fallback: "No model is set up for Pin, so the keyword sorter was used.", secretCount: 1, proposals: [{ key: "p1", title: "Network basics", body: "gateway 10.0.0.1 pw ⟦redacted:password:s1⟧", folder: "Networking", folderIsNew: true, tags: ["network"], links: [], confidence: 0.9, reasons: [], secrets: [{ id: "s1", kind: "password", label: "pw", line: 1, length: 8 }], source: "rules" }] };
    handlers["POST /api/notes/sort"] = () => ({ draft, autoFiled: null });
    handlers[`POST /api/notes/sort/${draft.id}/accept`] = () => ({ created: [{ ...row, title: "Network basics", folder: "Networking" }], updated: [], batch: "b".repeat(12), secrets: { redacted: 1, vaulted: 0, kept: 0 } });
    handlers[`POST /api/notes/batches/${"b".repeat(12)}/undo`] = () => ({ removed: 1, restored: 0 });
    wrap(<NotesPage />);
    fireEvent.click((await screen.findAllByText("Sort a pile"))[0]);
    fireEvent.change(await screen.findByLabelText("Text to sort"), { target: { value: "gateway 10.0.0.1 pw hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: /Sort it/ }));
    expect(await screen.findByText("Review before filing")).toBeTruthy();
    expect(screen.getByText(/keyword sorter was used/)).toBeTruthy();
    expect(screen.getByText("1 likely secret found")).toBeTruthy();
    expect(screen.getByText("New folder")).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("/accept"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Accept all/ }));
    expect(await screen.findByText(/1 note filed/)).toBeTruthy();
    const accept = calls.find((c) => c.path.endsWith("/accept"))!;
    expect(accept.body.secrets).toBe("redact");
    expect(accept.body.edits[0]).toMatchObject({ key: "p1", include: true });
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(await screen.findByText("Those changes were put back.")).toBeTruthy();
  });

  it("lets a proposal be unticked and edited before accepting", async () => {
    handlers["GET /api/notes"] = () => list();
    handlers["GET /api/notes/shared"] = () => ({ notes: [] });
    const mk = (k: string, t: string) => ({ key: k, title: t, body: "x", folder: "Inbox", folderIsNew: false, tags: [], links: [], confidence: 0.3, reasons: [], secrets: [], source: "model" });
    const draft = { id: "e".repeat(16), createdAt: 1, engine: "model", fallback: null, secretCount: 0, proposals: [mk("p1", "One"), mk("p2", "Two")] };
    handlers["POST /api/notes/sort"] = () => ({ draft, autoFiled: null });
    handlers[`POST /api/notes/sort/${draft.id}/accept`] = () => ({ created: [], updated: [], batch: null, secrets: { redacted: 0, vaulted: 0, kept: 0 } });
    wrap(<NotesPage />);
    fireEvent.click((await screen.findAllByText("Sort a pile"))[0]);
    fireEvent.change(await screen.findByLabelText("Text to sort"), { target: { value: "one two" } });
    fireEvent.click(screen.getByRole("button", { name: /Sort it/ }));
    await screen.findByText("Review before filing");
    fireEvent.click(screen.getByLabelText('File "Two"'));
    fireEvent.change(screen.getAllByLabelText("Title")[0], { target: { value: "Uno" } });
    fireEvent.click(screen.getByRole("button", { name: /Accept 1 of 2/ }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/accept"))).toBe(true));
    const b = calls.find((c) => c.path.endsWith("/accept"))!.body;
    expect(b.edits).toEqual([{ key: "p1", title: "Uno", include: true }, { key: "p2", include: false }]);
  });
});

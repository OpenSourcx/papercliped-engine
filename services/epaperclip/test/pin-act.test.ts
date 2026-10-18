import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sseEvents } from "../src/pin.ts";
import { ACTS, gate, type Permission, type Risk } from "../src/features/pin-act.ts";
import { approvalWait } from "../src/features/pin-act-run.ts";
import { fakeProviders } from "./fakes.ts";
import { startPinApp } from "./fakes-pin.ts";

const KEY = "sk-test-0123456789abcdefWXYZ";
let h: Awaited<ReturnType<typeof startPinApp>>;
let prov: Awaited<ReturnType<typeof fakeProviders>>;
let sam: string;
const j = (r: Response): Promise<any> => r.json();
const put = (path: string, body: unknown) => h.call("PUT", path, { cookie: sam }, body);

beforeEach(async () => {
  Object.assign(approvalWait, { pollMs: 15, pingMs: 60_000, maxMs: 15 * 60_000 });
  prov = await fakeProviders();
  h = await startPinApp({ providers: prov.fetch });
  sam = await h.signIn("sam");
  expect((await put("/api/connectors/anthropic/credential", { apiKey: KEY })).status).toBe(200);
  await put("/api/pin/settings", { provider: "anthropic", model: "m-1", mode: "agent" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
  await prov.close();
});

/** The model asks for these tool calls one after another, then says it is done. */
const script = (calls: { name: string; input: unknown }[]) => {
  prov.set((req, res) => {
    const body = JSON.parse(req.body);
    const k = body.messages.filter((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result")).length;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    if (k >= calls.length) {
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All done." } });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } });
    } else {
      const c = calls[k];
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tu${k}`, name: c.name, input: {} } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } });
    }
    res.end();
  });
};
type Ev = { event: string; data: any };
const startChat = async (text = "do it") => {
  const r = await h.call("POST", "/api/pin/chat", { cookie: sam }, { messages: [{ role: "user", content: text }], context: {} });
  const out: Ev[] = [];
  const done = (async () => {
    for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) out.push({ event: e.event, data: JSON.parse(e.data) });
    return out;
  })();
  return { out, done };
};
const chat = async (text?: string) => (await startChat(text)).done;
const waitFor = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(f()).toBe(true);
};
const decide = (planId: string, stepId: string, action: "approve" | "reject", confirm?: string) => h.call("POST", `/api/pin/plans/${planId}/steps/${stepId}/${action}`, { cookie: sam }, confirm ? { confirm } : {});
const lastToolResults = () => JSON.stringify(JSON.parse(prov.asked.at(-1)!.body).messages.at(-1));

describe("permission modes", () => {
  it("decide what runs, what asks and what stays a plan", () => {
    const matrix: Record<Permission, Record<Risk, string>> = {
      plan: { safe: "plan", disruptive: "plan", destructive: "plan" },
      ask: { safe: "ask", disruptive: "ask", destructive: "ask" },
      accept: { safe: "run", disruptive: "ask", destructive: "ask" },
      auto: { safe: "run", disruptive: "run", destructive: "ask" },
      bypass: { safe: "run", disruptive: "run", destructive: "run" },
    };
    for (const [p, row] of Object.entries(matrix) as [Permission, Record<Risk, string>][]) for (const [r, want] of Object.entries(row) as [Risk, string][]) expect(gate(p, r)).toBe(want);
  });

  it("starts at ask, and bypass takes a typed word and is written to the audit trail", async () => {
    expect((await j(await h.call("GET", "/api/pin/settings", { cookie: sam }))).permission).toBe("ask");
    expect((await put("/api/pin/settings", { permission: "nonsense" })).status).toBe(400);
    const refused = await put("/api/pin/settings", { permission: "bypass" });
    expect(refused.status).toBe(409);
    expect((await j(refused)).code).toBe("confirm_bypass");
    expect((await j(await h.call("GET", "/api/pin/settings", { cookie: sam }))).permission).toBe("ask");
    expect((await j(await put("/api/pin/settings", { permission: "bypass", confirmBypass: "bypass" }))).permission).toBe("bypass");
    const audit = await j(await h.call("GET", "/api/access/audit", { cookie: sam }));
    expect(JSON.stringify(audit)).toContain("pin.permission");
    // Going back down never needs a word.
    expect((await j(await put("/api/pin/settings", { permission: "accept" }))).permission).toBe("accept");
  });

  it("plan mode offers no action tools; the others offer them", async () => {
    script([]);
    await put("/api/pin/settings", { permission: "plan" });
    await chat();
    let names = JSON.parse(prov.asked.at(-1)!.body).tools.map((t: any) => t.name);
    expect(names).toContain("propose_plan");
    expect(names).not.toContain("create_container");
    await put("/api/pin/settings", { permission: "ask" });
    await chat();
    names = JSON.parse(prov.asked.at(-1)!.body).tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_container", "create_vm", "power_machine", "delete_machine", "list_container_templates", "task_status"]));
    expect(names).not.toContain("propose_plan");
    expect(names).not.toContain("host_shell");
  });
});

describe("Pin creates a container", () => {
  const make = { name: "create_container", input: { hostname: "media", template: "debian-12", cores: 2, memory_mb: 1024, disk_gb: 12 } };

  it("accept edits: downloads the template, creates and starts it, and tells the model it happened", async () => {
    await put("/api/pin/settings", { permission: "accept" });
    script([make]);
    const ev = await chat("make me a debian container called media");
    expect(ev.some((e) => e.event === "approval")).toBe(false);
    const running = ev.find((e) => e.event === "tool" && e.data.status === "running")!;
    expect(running.data.label).toMatch(/Create container “media”/);
    const done = ev.find((e) => e.event === "tool" && e.data.status === "done")!;
    expect(done.data.result).toMatch(/Created container media as machine 300/);
    expect(done.data.result).toMatch(/template was downloaded first/);
    expect(done.data.result).toMatch(/192\.168\.1\.55\/24/);
    const made = h.pve.st.created.find((c) => c.hostname === "media")!;
    expect(made).toMatchObject({ vmid: "300", ostemplate: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", cores: "2", memory: "1024", rootfs: "local-lvm:12", unprivileged: "1", tags: "pin" });
    expect(made.net0).toMatch(/bridge=vmbr0/);
    expect(made.net0).toMatch(/ip=dhcp/);
    expect(made.password).toBeUndefined();
    expect(h.pve.guests.get(300)).toMatchObject({ name: "media", type: "lxc" });
    expect(lastToolResults()).toMatch(/outcome/);
    expect(lastToolResults()).toMatch(/done/);
    expect(ev.at(-1)!.event).toBe("done");
    // Run as the person, and written to the audit trail.
    expect(h.pve.calls.some((c) => c.method === "POST" && c.path === "/nodes/pve/lxc" && c.who === "sam@pve")).toBe(true);
    expect(JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: sam })))).toContain("pin.act.done");
  });

  it("ask: shows an approval in the chat, waits, and carries on once the person approves", async () => {
    script([make]);
    const { out, done } = await startChat();
    await waitFor(() => out.some((e) => e.event === "approval"));
    const a = out.find((e) => e.event === "approval")!.data;
    expect(a).toMatchObject({ name: "create_container", destructive: false, confirmPhrase: null });
    expect(a.label).toMatch(/Create container “media”/);
    expect(h.pve.guests.has(300)).toBe(false); // nothing ran yet
    expect((await decide(a.planId, a.stepId, "approve")).status).toBe(200);
    const ev = await done;
    expect(ev.find((e) => e.event === "tool" && e.data.status === "done")!.data.result).toMatch(/Created container media/);
    expect(h.pve.guests.has(300)).toBe(true);
    expect(ev.at(-1)!.event).toBe("done");
  });

  it("ask: declining means nothing happens and the model is told not to retry", async () => {
    script([make]);
    const { out, done } = await startChat();
    await waitFor(() => out.some((e) => e.event === "approval"));
    const a = out.find((e) => e.event === "approval")!.data;
    expect((await decide(a.planId, a.stepId, "reject")).status).toBe(200);
    const ev = await done;
    expect(ev.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toMatch(/declined/);
    expect(h.pve.guests.has(300)).toBe(false);
    expect(lastToolResults()).toMatch(/declined/);
  });

  it("ask: an answer that never comes cancels it", async () => {
    approvalWait.maxMs = 120;
    script([make]);
    const ev = await chat();
    expect(ev.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toMatch(/Not decided/);
    expect(h.pve.guests.has(300)).toBe(false);
    expect(lastToolResults()).toMatch(/not_decided/);
    expect((await j(await h.call("GET", "/api/pin/plans", { cookie: sam }))).waiting).toBe(0);
  });

  it("refuses what it can't use: unknown fields, a password, a missing machine", async () => {
    await put("/api/pin/settings", { permission: "accept" });
    script([{ name: "create_container", input: { hostname: "x", template: "debian-12", password: "hunter22" } }, { name: "snapshot_machine", input: { vmid: 999, name: "nope" } }]);
    const ev = await chat();
    const errors = ev.filter((e) => e.event === "tool" && e.data.status === "error").map((e) => e.data.error);
    expect(errors[0]).toMatch(/no field “password”/);
    expect(errors[1]).toMatch(/no machine 999/);
    expect(h.pve.st.created).toHaveLength(0);
  });
});

describe("other things Pin can make and do", () => {
  it("creates a virtual machine with an ISO attached, and backs a machine up", async () => {
    await put("/api/pin/settings", { permission: "accept" });
    script([{ name: "create_vm", input: { name: "lab", iso: "local:iso/debian-12.iso", memory_mb: 4096, cores: 4, disk_gb: 40 } }, { name: "backup_machine", input: { vmid: 101 } }]);
    const ev = await chat("a lab vm, then back up web");
    const done = ev.filter((e) => e.event === "tool" && e.data.status === "done").map((e) => e.data.result);
    expect(done[0]).toMatch(/Created virtual machine lab as machine 300.*not started/);
    expect(done[1]).toMatch(/Backed up web \(101\) to backups/);
    const vm = h.pve.st.created.find((c) => c.name === "lab")!;
    expect(vm).toMatchObject({ vmid: "300", memory: "4096", cores: "4", tags: "pin" });
    expect(vm.ide2).toMatch(/local:iso\/debian-12\.iso/);
    expect(vm.scsi0).toMatch(/local-lvm:40/);
    expect(h.pve.st.created.find((c) => c.vmid === "101")).toMatchObject({ storage: "backups", mode: "snapshot" });
  });

  it("looks before it acts: templates, ISOs, bridges and task status are readable", async () => {
    script([{ name: "list_container_templates", input: {} }, { name: "list_isos", input: {} }, { name: "list_bridges", input: {} }]);
    const ev = await chat("what can I build with?");
    expect(ev.filter((e) => e.event === "tool" && e.data.status === "done").map((e) => e.data.name)).toEqual(["list_container_templates", "list_isos", "list_bridges"]);
    const seen = JSON.stringify(JSON.parse(prov.asked.at(-1)!.body).messages);
    expect(seen).toMatch(/debian-12-standard/);
    expect(seen).toMatch(/vmbr0/);
  });
});

describe("what can't be undone still asks, until bypass", () => {
  const rollback = { name: "rollback_snapshot", input: { vmid: 101, name: "before" } };

  it("auto: runs a shutdown now, but a rollback asks and needs the typed phrase", async () => {
    await put("/api/pin/settings", { permission: "auto" });
    script([{ name: "power_machine", input: { vmid: 101, action: "shutdown" } }, rollback]);
    const { out, done } = await startChat();
    await waitFor(() => out.some((e) => e.event === "approval"));
    expect(h.pve.guests.get(101)!.status).toBe("stopped"); // the shutdown ran without asking
    const a = out.find((e) => e.event === "approval")!.data;
    expect(a).toMatchObject({ destructive: true, confirmPhrase: "rollback 101" });
    const early = await decide(a.planId, a.stepId, "approve");
    expect(early.status).toBe(409);
    expect((await decide(a.planId, a.stepId, "approve", "rollback 101")).status).toBe(200);
    const ev = await done;
    expect(ev.filter((e) => e.event === "tool" && e.data.status === "done")).toHaveLength(2);
  });

  it("accept: a shutdown asks (and is a click), starting a machine does not", async () => {
    await put("/api/pin/settings", { permission: "accept" });
    h.pve.guests.get(101)!.status = "stopped";
    script([{ name: "power_machine", input: { vmid: 101, action: "start" } }, { name: "power_machine", input: { vmid: 101, action: "shutdown" } }]);
    const { out, done } = await startChat();
    await waitFor(() => out.some((e) => e.event === "approval"));
    expect(h.pve.guests.get(101)!.status).toBe("running"); // the start ran
    const a = out.find((e) => e.event === "approval")!.data;
    expect(a).toMatchObject({ destructive: false, confirmPhrase: null });
    expect((await decide(a.planId, a.stepId, "approve")).status).toBe(200);
    await done;
    expect(h.pve.guests.get(101)!.status).toBe("stopped");
  });

  it("bypass: a rollback runs with no question, and is still audited as the person", async () => {
    await put("/api/pin/settings", { permission: "bypass", confirmBypass: "bypass" });
    script([rollback]);
    const ev = await chat();
    expect(ev.some((e) => e.event === "approval")).toBe(false);
    expect(ev.find((e) => e.event === "tool" && e.data.status === "done")!.data.result).toMatch(/Rolled web \(101\) back to before/);
    expect(h.pve.calls.some((c) => c.path.endsWith("/snapshot/before/rollback") && c.who === "sam@pve")).toBe(true);
    expect(JSON.stringify(await j(await h.call("GET", "/api/access/audit", { cookie: sam })))).toContain("pin.act.run");
  });

  it("still bound by Proxmox: a person without the privilege is refused even in bypass", async () => {
    const lee = await h.signIn("lee");
    await h.call("PUT", "/api/connectors/anthropic/credential", { cookie: lee }, { apiKey: KEY }); // not an administrator: refused, sam's key stays
    await h.call("PUT", "/api/pin/settings", { cookie: lee }, { provider: "anthropic", model: "m-1", mode: "agent", permission: "bypass", confirmBypass: "bypass" });
    script([{ name: "power_machine", input: { vmid: 102, action: "stop" } }]);
    const r = await h.call("POST", "/api/pin/chat", { cookie: lee }, { messages: [{ role: "user", content: "stop cache" }], context: {} });
    const ev: Ev[] = [];
    for await (const e of sseEvents(r.body as unknown as AsyncIterable<Uint8Array>)) ev.push({ event: e.event, data: JSON.parse(e.data) });
    expect(ev.find((e) => e.event === "tool" && e.data.status === "error")!.data.error).toMatch(/no machine 102|permission/);
    expect(h.pve.guests.get(102)!.status).toBe("running");
  });
});

describe("the action list", () => {
  it("is parsed strictly and described in words", () => {
    expect(() => ACTS.create_vm.parse({ name: "bad name!" })).toThrow();
    expect(() => ACTS.resize_disk.parse({ vmid: 100, disk: "../etc", grow_gb: 1 })).toThrow();
    expect(() => ACTS.set_machine_config.parse({ vmid: 100 })).toThrow(/Say what to change/);
    expect(() => ACTS.create_container.parse({ hostname: "a", template: "debian-12", ipv4: "999.1.1.1/24" })).toThrow();
    expect(ACTS.delete_machine.describe(ACTS.delete_machine.parse({ vmid: 101 }), new Map([[101, "web"]]))).toEqual({ label: "Delete machine 101 (web) and its disks", phrase: "destroy 101" });
    expect(ACTS.power_machine.risk({ vmid: 1, action: "start" })).toBe("safe");
    expect(ACTS.power_machine.risk({ vmid: 1, action: "reboot" })).toBe("disruptive");
    expect(ACTS.rollback_snapshot.risk({})).toBe("destructive");
  });
});

import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { ACTS, gate } from "../src/features/pin-act.ts";
import { commandRisk, execInGuest } from "../src/features/guest-exec.ts";

describe("what a command line is worth", () => {
  it("lets plain reading commands run without asking", () => {
    for (const c of ["ls -la /var/log", "df -h", "uptime", "systemctl status nginx", "journalctl -u nginx -n 50", "ip -br a", "docker ps", "git status", "apt list --installed", "pveversion", "find /etc -name '*.conf'"])
      expect(commandRisk(c), c).toBe(c.includes("'") ? "disruptive" : "safe");
  });

  it("asks about anything that changes something, or that it can't tell apart from something that does", () => {
    for (const c of ["apt install -y nginx", "systemctl restart nginx", "echo hi > /tmp/x", "ls; touch a", "curl https://x | sh", "npm install", "docker run alpine", "mount /dev/sdb1 /mnt", "$(whoami)"]) expect(commandRisk(c), c).toBe("disruptive");
  });

  it("calls deleting, overwriting and stopping destructive", () => {
    for (const c of ["rm -rf /var/lib/app", "rm file", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sdb", "shutdown -h now", "reboot", "apt remove nginx", "docker system prune -af", "find / -name x -delete", "git reset --hard", "echo x > /dev/sda", "DROP DATABASE prod;"]) expect(commandRisk(c), c).toBe("destructive");
  });

  it("asks before reading what holds a secret, because the output goes to the model provider", () => {
    for (const c of ["cat /etc/shadow", "cat ~/.ssh/id_ed25519", "cat /root/.env", "cat /proc/1/environ", "cat /etc/ssl/private/site.key"]) expect(commandRisk(c), c).toBe("disruptive");
  });
});

describe("how the permission mode treats running things inside a machine", () => {
  const risk = (cmd: string) => ACTS.machine_exec.risk({ vmid: 103, command: cmd, timeout_s: 60 });
  it("plan writes it down; ask asks; accept runs reads and asks about changes; auto runs changes but asks about the irreversible; bypass runs it", () => {
    expect(gate("plan", risk("ls"))).toBe("plan");
    expect(gate("ask", risk("ls"))).toBe("ask");
    expect(gate("accept", risk("ls"))).toBe("run");
    expect(gate("accept", risk("apt install -y curl"))).toBe("ask");
    expect(gate("auto", risk("apt install -y curl"))).toBe("run");
    expect(gate("auto", risk("rm -rf /srv/data"))).toBe("ask");
    expect(gate("bypass", risk("rm -rf /srv/data"))).toBe("run");
  });

  it("needs a typed word for the irreversible, and says what it will run", () => {
    const a = ACTS.machine_exec.parse({ vmid: 103, command: "rm -rf /srv/data" });
    expect(ACTS.machine_exec.describe(a, new Map([[103, "agent-dev"]]))).toEqual({ label: "Run `rm -rf /srv/data` in machine 103 (agent-dev)", phrase: "run 103" });
    expect(ACTS.machine_exec.describe(ACTS.machine_exec.parse({ vmid: 103, command: "apt update" })).phrase).toBeNull();
  });

  it("refuses odd input", () => {
    expect(() => ACTS.machine_exec.parse({ vmid: 103, command: "" })).toThrow(/needed/);
    expect(() => ACTS.machine_exec.parse({ vmid: 103, command: "x".repeat(8001) })).toThrow(/8000/);
    expect(() => ACTS.machine_exec.parse({ vmid: 103, command: "ls", extra: 1 })).toThrow(/no field/);
    expect(() => ACTS.machine_read_file.parse({ vmid: 103, path: "relative/path" })).toThrow(/absolute/);
    expect(() => ACTS.machine_read_file.parse({ vmid: 103, path: "/etc/../shadow" })).toThrow(/absolute/);
    expect(() => ACTS.machine_write_file.parse({ vmid: 103, path: "/tmp/x", content: "a\0b" })).toThrow(/text/);
  });

  it("treats system files as irreversible to write and credential files as something to ask about reading", () => {
    expect(ACTS.machine_write_file.risk({ vmid: 1, path: "/etc/fstab", content: "" })).toBe("destructive");
    expect(ACTS.machine_write_file.risk({ vmid: 1, path: "/srv/app/config.json", content: "{}" })).toBe("disruptive");
    expect(ACTS.machine_read_file.risk({ vmid: 1, path: "/var/log/syslog" })).toBe("safe");
    expect(ACTS.machine_read_file.risk({ vmid: 1, path: "/root/.ssh/id_rsa" })).toBe("disruptive");
  });
});

describe("running in a VM through the guest agent", () => {
  const fakePve = (over: Partial<Record<string, unknown>> = {}) => ({
    agentExec: async () => ({ pid: 7 }),
    agentExecStatus: (() => {
      let n = 0;
      return async () => (++n < 2 ? { exited: 0 } : { exited: 1, exitcode: 3, "out-data": "hello\n", "err-data": "oops\n" });
    })(),
    ...over,
  }) as unknown as ProxmoxClient;

  it("polls until the command ends, and returns the exit code with output and errors", async () => {
    const r = await execInGuest({ pve: async () => fakePve(), connect: () => { throw new Error("not used"); }, sleep: async () => undefined }, { type: "qemu", vmid: 100, node: "pve" }, "echo hello", { timeoutMs: 5000 });
    expect(r).toEqual({ exitCode: 3, output: "hello\n[stderr]\noops\n", timedOut: false, truncated: false });
  });

  it("says plainly when the guest agent isn't running", async () => {
    const { ProxmoxError } = await import("@papercliped-engine/proxmox-client");
    const pve = fakePve({ agentExec: async () => { throw new ProxmoxError("failed", 500, "QEMU guest agent is not running"); } });
    await expect(execInGuest({ pve: async () => pve, connect: () => { throw new Error("x"); } }, { type: "qemu", vmid: 100, node: "pve" }, "ls", { timeoutMs: 1000 })).rejects.toThrow(/guest agent isn't running/);
  });

  it("reports a command that outlives the wait", async () => {
    const pve = fakePve({ agentExecStatus: async () => ({ exited: 0 }) });
    const r = await execInGuest({ pve: async () => pve, connect: () => { throw new Error("x"); }, sleep: async () => undefined }, { type: "qemu", vmid: 100, node: "pve" }, "sleep 999", { timeoutMs: 1 });
    expect(r.timedOut).toBe(true);
  });
});

describe("running in a container through private pipes", () => {
  const guest = { type: "lxc" as const, vmid: 103, node: "pve" };
  const pve = { execAuth: () => ({ ticket: "fixture" }), terminalTarget: () => { throw new Error("must never open terminal"); } } as unknown as ProxmoxClient;
  async function withHelper(reply: unknown, check: (socket: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "epc-exec-"));
    const socket = join(dir, "exec.sock");
    const server = createServer({ allowHalfOpen: true }, s => {
      let body = "";
      s.on("data", b => body += b);
      s.on("end", () => {
        expect(JSON.parse(body)).toMatchObject({ vmid: 103, node: "pve", auth: { ticket: "fixture" }, script: "echo hi" });
        s.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>(r => server.listen(socket, r));
    try { await check(socket); } finally { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true }); }
  }
  const host = (socket: string) => ({ pve: async () => pve, connect: () => { throw new Error("no console"); }, localNode: "pve", execSocket: socket });
  for (const result of [
    { exitCode: 4, output: "hi\n", timedOut: false, truncated: false },
    { exitCode: null, output: "", timedOut: true, truncated: false },
    { exitCode: 0, output: "x".repeat(65536), timedOut: false, truncated: true },
  ]) it(`returns helper result (timeout=${result.timedOut}, truncated=${result.truncated})`, async () => {
    await withHelper(result, async socket => { expect(await execInGuest(host(socket), guest, "echo hi", { timeoutMs: 1000 })).toEqual(result); });
  });
  it("surfaces independent authorization refusal", async () => {
    await withHelper({ error: "VM.Console required" }, async socket => { await expect(execInGuest(host(socket), guest, "echo hi", { timeoutMs: 1000 })).rejects.toThrow(/VM.Console/); });
  });
  it("explains a missing helper", async () => {
    await expect(execInGuest(host("/tmp/epc-missing-socket"), guest, "echo hi", { timeoutMs: 1000 })).rejects.toThrow(/exec helper on node pve/);
  });
  it("refuses a remote node before connecting", async () => {
    await expect(execInGuest(host("/not-used"), { ...guest, node: "remote" }, "echo hi", { timeoutMs: 1000 })).rejects.toThrow(/node that hosts the container \(remote\)/);
  });
});

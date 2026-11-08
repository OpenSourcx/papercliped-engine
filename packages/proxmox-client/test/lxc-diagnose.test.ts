import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diagnoseLxc, redactLines, relevantJournal, summarizeDiagnosis } from "../src/lxc-diagnose.ts";

/** The owner's real failure, as Proxmox's task log showed it (simulated input; the text is the screenshot's). */
const OWNER_LOG = [
  "sync_wait: 34 An error occurred in another process (expected sequence number 7)",
  '__lxc_start: 2288 Failed to spawn container "104"',
  "TASK ERROR: startup for container '104' failed",
];

describe("LXC failure diagnosis", () => {
  it("says what the owner's generic start failure means and which checks find the cause, without inventing one", () => {
    const d = diagnoseLxc({ exitstatus: "startup for container '104' failed", log: OWNER_LOG, vmid: 104, storage: { name: "drive2", type: "dir", active: true, availBytes: 500 * 1024 ** 3 } });
    expect(d.id).toBe("unknown-start-failure");
    expect(d.confidence).toBe("generic");
    expect(d.plain).toContain("step 7");
    expect(d.plain).toContain("Nothing in the task log or the host journal matched a known cause");
    expect(d.plain).toContain('dir storage "drive2"');
    expect(d.fix.join("\n")).toContain("lxc-start -n 104 -F -l DEBUG -o /tmp/lxc-104.log");
    expect(d.fix.join("\n")).toContain("vzstart:104");
    expect(d.fix.join("\n")).toContain("root:100000:65536");
    expect(d.evidence).toEqual(OWNER_LOG);
  });

  it.each([
    ["template-missing", ["TASK ERROR: unable to create CT 104 - volume 'drive2:vztmpl/debian-12.tar.zst' does not exist"]],
    ["template-corrupt", ["extracting archive 'drive2:vztmpl/x.tar.zst'", "zstd: /var/lib/vz/template/cache/x.tar.zst: unexpected end of file", "TASK ERROR: unable to create CT"]],
    ["wrong-architecture", ["lxc_init: 845 Failed to run init: Exec format error"]],
    ["no-space", ["Logical volume 'vm-104-disk-0' failed: No space left on device"]],
    ["storage-unavailable", ["TASK ERROR: storage 'drive2' is not online"]],
    ["storage-ownership", ["chown: changing ownership of '/mnt/drive2/images/104': Operation not permitted"]],
    ["mount-denied", ['mount: /var/lib/lxc/104/rootfs: wrong fs type, bad option, bad superblock on /dev/loop3']],
    ["idmap", ["newuidmap: write to uid_map failed: Operation not permitted", "sync_wait: 34 An error occurred in another process (expected sequence number 7)"]],
    ["apparmor", ["sync_wait: 34 An error occurred in another process (expected sequence number 7)"], ['audit: type=1400 audit(1): apparmor="DENIED" operation="mount" profile="lxc-104_</var/lib/lxc>" name="/sys/"']],
    ["cgroup", ["lxc_spawn: 1840 Failed to create cgroup \"104\"", 'cgfsng_payload_create: Permission denied - Failed to create cgroup']],
    ["namespaces", ["clone3: Operation not permitted", "Failed to clone a new set of namespaces"]],
    ["features", ['Permission denied - Failed to mount "proc" onto "/usr/lib/x86_64-linux-gnu/lxc/rootfs/proc"']],
    ["network", ["bridge 'vmbr7' does not exist"]],
    ["devices", ["lxc_setup_devpts: 1612 Failed to create new devpts instance"]],
    ["locked", ["TASK ERROR: can't lock file '/run/lock/lxc/pve-config-104.lock' - got timeout"]],
    ["no-init", ["Failed to exec /sbin/init: No such file or directory"]],
    ["memory", ["Memory cgroup out of memory: Killed process 4242 (systemd)"]],
    ["pre-start-hook", ["run_buffer: 571 Script exited with status 32", "lxc_init: 845 Failed to run lxc.hook.pre-start for container \"104\""]],
  ] as [string, string[], string[]?][])("recognizes %s", (id, log, journal) => {
    const d = diagnoseLxc({ exitstatus: "startup for container '104' failed", log, journal, vmid: 104 });
    expect(d.id).toBe(id);
    expect(d.confidence).toBe("matched");
    expect(d.plain.length).toBeGreaterThan(30);
    expect(d.fix.length).toBeGreaterThan(0);
  });

  it("uses a no-features probe result: it starts without nesting", () => {
    const d = diagnoseLxc({ log: OWNER_LOG, vmid: 104, config: { features: "nesting=1" }, startsWithoutFeatures: true });
    expect(d.id).toBe("features-blocked");
    expect(d.plain).toContain("nesting=1");
  });

  it("says nesting is not the cause when the same failure happens without features", () => {
    const d = diagnoseLxc({ log: OWNER_LOG, vmid: 104, config: { features: "nesting=1" }, startsWithoutFeatures: false });
    expect(d.id).toBe("unknown-start-failure");
    expect(d.plain).toContain("nesting is not the cause");
  });

  it("warns about inactive and nearly full storage in the generic case", () => {
    const d = diagnoseLxc({ log: OWNER_LOG, vmid: 104, storage: { name: "drive2", type: "dir", active: false, availBytes: 1024 ** 3 } });
    expect(d.plain).toContain("not active");
    expect(d.plain).toContain("1.0 GiB free");
  });

  it("is honest when it is not a start failure and nothing matches", () => {
    const d = diagnoseLxc({ exitstatus: "something odd", log: ["TASK ERROR: something odd"] });
    expect(d.id).toBe("unknown");
    expect(d.plain).toContain("something odd");
  });

  it("keeps the evidence short but includes the lines that matter", () => {
    const log = Array.from({ length: 300 }, (_, i) => `progress ${i}`);
    log[40] = "zstd: x.tar.zst: unexpected end of file";
    log.push("TASK ERROR: unable to create CT");
    const d = diagnoseLxc({ log });
    expect(d.id).toBe("template-corrupt");
    expect(d.evidence.length).toBeLessThanOrEqual(25);
    expect(d.evidence).toContain("zstd: x.tar.zst: unexpected end of file");
    expect(d.evidence.at(-1)).toBe("TASK ERROR: unable to create CT");
  });

  it("removes secrets from everything it shows", () => {
    const secret = "11111111-2222-4333-8444-555555555555";
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQAB\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactLines([`epaperclip-sandbox@pve!sandbox=${secret}`, "Authorization: PVEAPIToken=a@pve!b=" + secret, "PVEAuthCookie=PVE:sam@pve:ABC", "password=hunter2", ...key.split("\n"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl x"]);
    const text = out.join("\n");
    for (const bad of [secret, "hunter2", "PVE:sam@pve:ABC", "AAAAB3NzaC1yc2EAAAADAQAB", "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"]) expect(text).not.toContain(bad);
    const d = diagnoseLxc({ log: ["sync_wait: 34 An error occurred in another process (expected sequence number 7)", `token=${secret}`] });
    expect(JSON.stringify(d)).not.toContain(secret);
  });

  it("picks only journal lines that can belong to the failure", () => {
    const j = ["Nov 8 kernel: audit: apparmor=\"DENIED\" operation=\"mount\"", "Nov 8 sshd[1]: Accepted publickey", "Nov 8 systemd[1]: Started pve-container@104.service", "Nov 8 pve-container@205: other"];
    expect(relevantJournal(j, 104)).toEqual([j[0], j[2]]);
  });

  it("summarizes in one paragraph with the first fix", () => {
    const d = diagnoseLxc({ log: OWNER_LOG, vmid: 104 });
    expect(summarizeDiagnosis(d)).toMatch(/^The container's init process died while starting\. .* Fix: On the host, run LXC in the foreground/);
  });

  it("is identical to the copy inside the standalone sandbox plugin", () => {
    const a = readFileSync(new URL("../src/lxc-diagnose.ts", import.meta.url), "utf8");
    const b = readFileSync(new URL("../../../plugins/proxmox-sandbox/src/lxc-diagnose.ts", import.meta.url), "utf8");
    expect(b).toBe(a);
  });
});

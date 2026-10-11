import { describe, expect, it } from "vitest";
import { DemoShell } from "../src/terminal/demoShell.ts";
import { DemoTransport } from "../src/terminal/transport.ts";

const machine = { kind: "lxc" as const, name: "behive-forge", os: "Debian 13", ip: "10.10.0.20", cores: 2, memUsed: 1.3 * 1024 ** 3, memMax: 2 * 1024 ** 3, diskMax: 8 * 1024 ** 3, uptimeSec: 7200 };

describe("demo shell", () => {
  it("answers from the machine's own data", () => {
    const sh = new DemoShell(machine);
    expect(sh.run("hostname").out).toBe("behive-forge");
    expect(sh.run("nproc").out).toBe("2");
    expect(sh.run("ip a").out).toContain("10.10.0.20/24");
    expect(sh.run("cat /etc/os-release").out).toContain('PRETTY_NAME="Debian 13"');
    expect(sh.run("free -h").out).toContain("2.0G");
  });

  it("navigates directories and reports unknown commands honestly", () => {
    const sh = new DemoShell(machine);
    expect(sh.run("cd paperclip-workspace").out).toBe("");
    expect(sh.cwd).toBe("/root/paperclip-workspace");
    expect(sh.run("cd ..").out).toBe("");
    expect(sh.cwd).toBe("/root");
    expect(sh.run("cd /nope").out).toMatch(/No such file/);
    expect(sh.run("rm -rf /").out).toBe("bash: rm: command not found");
  });

  it("completes commands and paths", () => {
    const sh = new DemoShell(machine);
    expect(sh.complete("hostn")).toEqual(["hostname"]);
    expect(sh.complete("cd paper")).toEqual(["cd paperclip-workspace"]);
  });
});

describe("demo terminal line discipline", () => {
  const drive = (keys: string[]) => {
    let out = "";
    let exited = false;
    const t = new DemoTransport(machine);
    t.open((d) => (out += d), () => (exited = true));
    out = "";
    for (const k of keys) t.input(k);
    return { out, exited: () => exited };
  };

  it("echoes typing, runs the line on Enter, and edits with Backspace", () => {
    const r = drive([..."whoamx", "\x7f", "i", "\r"]);
    expect(r.out).toContain("whoami");
    expect(r.out).toContain("\r\nroot\r\n");
  });

  it("recalls history with the up arrow, cancels with Ctrl+C, and ends on exit", () => {
    const r = drive([..."pwd", "\r", "\x1b[A", "\r", ..."partial", "\x03", ..."exit", "\r"]);
    expect(r.out.match(/\/root/g)?.length).toBeGreaterThanOrEqual(2);
    expect(r.out).toContain("^C");
    expect(r.out).toContain("Session ended");
    expect(r.exited()).toBe(true);
  });
});

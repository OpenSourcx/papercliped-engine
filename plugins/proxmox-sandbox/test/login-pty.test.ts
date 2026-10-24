import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createProxmoxSandboxPlugin } from "../src/plugin.js";
import { loginCommandLine } from "../src/login-pty.js";
import { buildSshArgs, type PtySession, type SshTarget } from "../src/ssh.js";
import { FakeProxmox } from "./fake-proxmox.js";
import { baseConfig, createLocalShell, generatePemKey, noSleep } from "./helpers.js";

const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-1" };
const HOME = "/tmp/paperclip-adapter-login/0a1b2c3d-1111-2222-3333-444455556666";

let pve: FakeProxmox;
let key: string;
let home: string;

beforeAll(async () => {
  pve = new FakeProxmox();
  await pve.start();
  key = generatePemKey();
});
afterAll(async () => {
  await pve.stop();
});
beforeEach(() => {
  pve.containers.clear();
  pve.nextVmid = 101;
  pve.addTemplate(9000);
  home = mkdtempSync(path.join(tmpdir(), "pve-login-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function fakePty() {
  const opened: { target: SshTarget; command: string }[] = [];
  const written: string[] = [];
  const state = { killed: 0, closed: 0 };
  let emit: (chunk: string) => void = () => {};
  let finish: (r: { exitCode: number | null }) => void = () => {};
  const session: PtySession = {
    onData: (l) => void (emit = l),
    write: (d) => void written.push(d),
    wait: () => new Promise((r) => void (finish = r)),
    kill: () => void state.killed++,
    close: async () => void state.closed++,
  };
  return { opener: async (target: SshTarget, command: string) => (opened.push({ target, command }), session), opened, written, state, push: (c: string) => emit(c), exit: (code: number | null) => finish({ exitCode: code }) };
}

async function setup() {
  const pty = fakePty();
  const out: { kind: string; args: unknown[] }[] = [];
  const plugin = createProxmoxSandboxPlugin({ ssh: createLocalShell(home).runner, sleep: noSleep, killGraceSeconds: 0, openPty: pty.opener });
  await plugin.definition.setup({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    loginPty: { output: (...a: unknown[]) => out.push({ kind: "output", args: a }), exit: (...a: unknown[]) => out.push({ kind: "exit", args: a }) },
  } as unknown as PluginContext);
  const hooks = plugin.definition;
  const lease = await hooks.onEnvironmentAcquireLease!({ ...base, config: baseConfig(pve, key), runId: "run-1" });
  return { pty, out, hooks, lease };
}

describe("login command", () => {
  it("builds a fixed command per key with its own home, and refuses anything else", () => {
    expect(loginCommandLine("claude", HOME)).toContain("CLAUDE_CONFIG_DIR=");
    expect(loginCommandLine("codex", HOME)).toContain("codex login --device-auth");
    expect(loginCommandLine("grok", HOME)).toContain("GROK_HOME=");
    expect(() => loginCommandLine("bash", HOME)).toThrow(/isn't supported/);
    expect(() => loginCommandLine("claude", "/tmp/paperclip-adapter-login/../../etc")).toThrow(/expected form/);
    expect(() => loginCommandLine("claude", `${HOME}; rm -rf /`)).toThrow(/expected form/);
  });

  it("asks ssh for a terminal only when told to", () => {
    const target: SshTarget = { host: "10.0.0.5", port: 22, user: "agent", privateKey: "k", hostKeyAlias: "a", knownHosts: "x" };
    const args = (tty?: boolean) => buildSshArgs({ target, identityFile: "i", knownHostsFile: "k", acceptNewHostKey: false, command: "c", tty });
    expect(args()[0]).toBe("-T");
    expect(args(true)[0]).toBe("-tt");
  });
});

describe("login pseudo-terminal hooks", () => {
  it("opens a terminal in the leased container, streams output and the exit, takes input, and closes", async () => {
    const { pty, out, hooks, lease } = await setup();
    const opened = await hooks.onLoginPtyOpen!({ hostRouteId: "route-1", ...base, providerLeaseId: lease.providerLeaseId!, loginCommandKey: "codex", sessionHome: HOME });
    expect(pty.opened).toHaveLength(1);
    expect(pty.opened[0]!.command).toContain("CODEX_HOME=");
    expect(pty.opened[0]!.target.host).toBe(String((lease.metadata as { ip: string }).ip));
    pty.push("Open https://example.test and enter code ABCD");
    expect(out[0]).toEqual({ kind: "output", args: ["route-1", opened.workerSessionId, "Open https://example.test and enter code ABCD"] });
    await hooks.onLoginPtyInput!({ workerSessionId: opened.workerSessionId, data: "pasted-code\r" });
    expect(pty.written).toEqual(["pasted-code\r"]);
    pty.exit(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(out.at(-1)).toEqual({ kind: "exit", args: ["route-1", opened.workerSessionId, 0] });
    expect(pty.state.closed).toBe(1);
    await expect(hooks.onLoginPtyClose!({ hostRouteId: "route-1" })).resolves.toEqual({ hostRouteId: "route-1" });
  });

  it("stops the terminal on request and on close", async () => {
    const { pty, hooks, lease } = await setup();
    const opened = await hooks.onLoginPtyOpen!({ hostRouteId: "route-2", ...base, providerLeaseId: lease.providerLeaseId!, loginCommandKey: "claude", sessionHome: HOME });
    await hooks.onLoginPtyStop!({ workerSessionId: opened.workerSessionId });
    expect(pty.state.killed).toBe(1);
    await hooks.onLoginPtyClose!({ hostRouteId: "route-2" });
    expect(pty.state.killed).toBe(2);
    expect(pty.state.closed).toBe(1);
  });

  it("refuses a lease it doesn't know, an unknown login and a wrong home, and opens nothing", async () => {
    const { pty, hooks, lease } = await setup();
    await expect(hooks.onLoginPtyOpen!({ hostRouteId: "r", ...base, providerLeaseId: "pve/999", loginCommandKey: "claude", sessionHome: HOME })).rejects.toThrow(/isn't connected/);
    await expect(hooks.onLoginPtyOpen!({ hostRouteId: "r", ...base, providerLeaseId: lease.providerLeaseId!, loginCommandKey: "bash" as never, sessionHome: HOME })).rejects.toThrow(/isn't supported/);
    await expect(hooks.onLoginPtyOpen!({ hostRouteId: "r", ...base, providerLeaseId: lease.providerLeaseId!, loginCommandKey: "claude", sessionHome: "/root" })).rejects.toThrow(/expected form/);
    expect(pty.opened).toHaveLength(0);
  });
});

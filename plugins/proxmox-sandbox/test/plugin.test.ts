import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext, PluginEnvironmentLease } from "@paperclipai/plugin-sdk";
import { createProxmoxSandboxPlugin, buildTags, sanitizeTag } from "../src/plugin.js";
import { validateSshPrivateKey } from "../src/config.js";
import { derivePublicKey } from "../src/ssh-keys.js";
import { buildExecScript } from "../src/ssh.js";
import manifest from "../src/manifest.js";
import { FakeProxmox } from "./fake-proxmox.js";
import { baseConfig, createLocalShell, generateOpenSshKey, generatePemKey, hasBinary, noSleep, type LocalShell } from "./helpers.js";

const HAS_SSH_KEYGEN = hasBinary("ssh-keygen");
const base = { driverKey: "proxmox", companyId: "company-1", environmentId: "env-1" };

let pve: FakeProxmox;
let key: string;
let home: string;
let shell: LocalShell;
let plugin: ReturnType<typeof createProxmoxSandboxPlugin>;
let hooks: ReturnType<typeof createProxmoxSandboxPlugin>["definition"];

beforeAll(async () => {
  pve = new FakeProxmox();
  await pve.start();
  key = generatePemKey();
});

afterAll(async () => {
  await pve.stop();
});

beforeEach(() => {
  pve.requests.length = 0;
  pve.containers.clear();
  pve.taskFailures.clear();
  pve.nextVmid = 101;
  pve.racesOnNextId = 0;
  pve.addTemplate(9000);
  home = mkdtempSync(path.join(tmpdir(), "pve-test-home-"));
  shell = createLocalShell(home);
  plugin = createProxmoxSandboxPlugin({ ssh: shell.runner, sleep: noSleep, killGraceSeconds: 0 });
  hooks = plugin.definition;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}) {
  return baseConfig(pve, key, overrides);
}

async function acquire(overrides: Record<string, unknown> = {}, runId = "run-1"): Promise<PluginEnvironmentLease> {
  return await hooks.onEnvironmentAcquireLease!({ ...base, config: config(overrides), runId });
}

describe("manifest", () => {
  it("declares the proxmox sandbox driver", () => {
    expect(manifest.id).toBe("epaperclip.proxmox-sandbox-provider");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.capabilities).toEqual(["environment.drivers.register"]);
    const driver = manifest.environmentDrivers![0]!;
    expect(driver).toMatchObject({ driverKey: "proxmox", kind: "sandbox_provider", sandboxCapabilities: { reusableLeases: true } });
    const props = (driver.configSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.apiTokenSecret!.format).toBe("secret-ref");
    expect(props.sshPrivateKey!.format).toBe("secret-ref");
    expect(props.unprivileged!.default).toBe(true);
    expect(props.allowInsecureTls!.default).toBe(false);
    expect(props.bridge!.default).toBe("vmbr0");
    expect(props.storage!["x-paperclip-advanced"]).toBe(true);
  });
});

describe("validate", () => {
  it("accepts a complete config and normalises it", async () => {
    const result = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ apiUrl: `${pve.url}/api2/json`, namePrefix: " My Agents! " }) });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ apiUrl: pve.url, namePrefix: "my-agents", unprivileged: true, bridge: "vmbr0", sshUser: "root" });
    expect(result.warnings!.join(" ")).toMatch(/trust on first use/);
  });

  it("rejects a public key pasted as the private key", async () => {
    const result = await hooks.onEnvironmentValidateConfig!({
      driverKey: "proxmox",
      config: config({ sshPrivateKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host" }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors!.join(" ")).toMatch(/PUBLIC key/);
  });

  it("rejects a truncated key and a PuTTY key", () => {
    expect(validateSshPrivateKey(key.split("\n").slice(0, 2).join("\n"))).toMatch(/footer/);
    expect(validateSshPrivateKey("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none")).toMatch(/PuTTY/);
  });

  it.skipIf(!HAS_SSH_KEYGEN)("rejects a passphrase-protected OpenSSH key", async () => {
    const encrypted = generateOpenSshKey("ed25519", "secret-pass");
    const result = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ sshPrivateKey: encrypted.privateKey }) });
    expect(result.ok).toBe(false);
    expect(result.errors!.join(" ")).toMatch(/passphrase/);
  });

  it("refuses privileged containers unless explicitly allowed", async () => {
    const refused = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ unprivileged: false }) });
    expect(refused.ok).toBe(false);
    expect(refused.errors!.join(" ")).toMatch(/Privileged containers are refused/);

    const allowed = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ unprivileged: false, allowPrivileged: true }) });
    expect(allowed.ok).toBe(true);
    expect(allowed.warnings!.join(" ")).toMatch(/root on the Proxmox host/);
  });

  it("checks required fields, the token id format, http URLs and the CA", async () => {
    const result = await hooks.onEnvironmentValidateConfig!({
      driverKey: "proxmox",
      config: {
        apiUrl: "http://pve:8006",
        apiTokenId: "not-a-token",
        caCert: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        template: "local:iso/foo.iso",
        cores: 0,
      },
    });
    const errors = result.errors!.join("\n");
    expect(result.ok).toBe(false);
    for (const pattern of [/must use https/, /node is required/, /apiTokenId must look like/, /apiTokenSecret is required/, /caCert/, /template must be/, /pool is required/, /cores/, /sshPrivateKey is required/]) {
      expect(errors).toMatch(pattern);
    }
  });

  it("skips content checks for saved secret references", async () => {
    const ref = "0b9c3d6e-1f2a-4b5c-8d7e-9f0a1b2c3d4e";
    const result = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ sshPrivateKey: ref, apiTokenSecret: ref }) });
    expect(result.ok).toBe(true);
  });

  it("accepts the token in Proxmox's full form, so a bare UUID secret is not mistaken for a saved-secret id", async () => {
    const full = `${pve.tokenId}=${pve.tokenSecret}`;
    const result = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ apiTokenId: "", apiTokenSecret: `PVEAPIToken=${full}` }) });
    expect(result.ok).toBe(true);
    // Secret fields are handed back untouched.
    expect(result.normalizedConfig!.apiTokenSecret).toBe(`PVEAPIToken=${full}`);
    expect(result.normalizedConfig).not.toHaveProperty("apiTokenIdConflict");
    const probe = await hooks.onEnvironmentProbe!({ ...base, config: config({ apiTokenId: undefined, apiTokenSecret: full }) });
    expect(probe.ok).toBe(true);

    const conflict = await hooks.onEnvironmentValidateConfig!({ driverKey: "proxmox", config: config({ apiTokenId: "other@pve!x", apiTokenSecret: full }) });
    expect(conflict.errors!.join(" ")).toMatch(/different token/);
  });

  it("requires storage when creating from a volid", async () => {
    const result = await hooks.onEnvironmentValidateConfig!({
      driverKey: "proxmox",
      config: config({ template: "local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst", storage: "" }),
    });
    expect(result.errors!.join(" ")).toMatch(/storage is required/);
  });
});

describe("ssh keys", () => {
  it("derives the public key from a PKCS#8 ed25519 key", () => {
    expect(derivePublicKey(key)).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/=]+$/);
  });

  it.skipIf(!HAS_SSH_KEYGEN)("matches ssh-keygen for OpenSSH ed25519, ecdsa and rsa keys", () => {
    for (const type of ["ed25519", "ecdsa", "rsa"] as const) {
      const generated = generateOpenSshKey(type);
      const expected = generated.publicKey.split(" ").slice(0, 2).join(" ");
      expect(derivePublicKey(generated.privateKey)).toBe(expected);
    }
  });
});

describe("probe", () => {
  it("summarises a ready environment", async () => {
    const result = await hooks.onEnvironmentProbe!({ ...base, config: config() });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Ready: Proxmox VE 8\.4\.1, node pve, template 9000, pool epaperclip/);
    expect(result.metadata).toMatchObject({ provider: "proxmox", proxmoxVersion: "8.4.1" });
    expect(result.metadata!.sshPublicKey).toMatch(/^ssh-ed25519 /);
    // A probe must not create anything.
    expect(pve.find("POST", /clone|\/lxc$/)).toHaveLength(0);
  });

  it("fails on a bad token, a missing pool, a privileged template and a missing volume", async () => {
    const badToken = await hooks.onEnvironmentProbe!({ ...base, config: config({ apiTokenSecret: "wrong" }) });
    expect(badToken.ok).toBe(false);
    expect(badToken.diagnostics!.map((d) => d.message).join(" ")).toMatch(/invalid token value/);

    pve.addTemplate(9001, { unprivileged: 0, mp0: "/srv/host-data,mp=/data" });
    const unsafe = await hooks.onEnvironmentProbe!({ ...base, config: config({ template: "9001", pool: "missing" }) });
    expect(unsafe.ok).toBe(false);
    const messages = unsafe.diagnostics!.map((d) => d.message).join("\n");
    expect(messages).toMatch(/privileged container/);
    expect(messages).toMatch(/bind-mounts a host path/);
    expect(messages).toMatch(/pool 'missing' does not exist/);

    const volid = await hooks.onEnvironmentProbe!({ ...base, config: config({ template: "local:vztmpl/nope.tar.zst" }) });
    expect(volid.ok).toBe(false);
    expect(volid.summary).toMatch(/does not exist/);
  });

  it("verifies TLS: system store fails for a self-signed cert unless insecure is explicitly allowed", async () => {
    const strict = await hooks.onEnvironmentProbe!({ ...base, config: config({ caCert: "" }) });
    expect(strict.ok).toBe(false);
    expect(strict.diagnostics!.map((d) => d.message).join(" ")).toMatch(/certificate/i);

    const insecure = await hooks.onEnvironmentProbe!({ ...base, config: config({ caCert: "", allowInsecureTls: true }) });
    expect(insecure.ok).toBe(true);
  });
});

describe("Proxmox HTTP layer", () => {
  it("authenticates with the API token and never sends chunked bodies", async () => {
    await acquire();
    expect(pve.requests.length).toBeGreaterThan(5);
    for (const request of pve.requests) {
      expect(request.authorization).toBe(`PVEAPIToken=${pve.tokenId}=${pve.tokenSecret}`);
      expect(request.chunked).toBe(false);
      if (request.method === "POST" || request.method === "PUT") {
        const body = new URLSearchParams(request.form).toString();
        expect(Number(request.contentLength)).toBe(Buffer.byteLength(body));
      }
    }
  });
});

describe("acquire", () => {
  it("clones the template, starts it, finds its address and waits for SSH", async () => {
    shell.failNext(2); // sshd not up yet for the first two attempts
    const lease = await acquire({ cores: 4, memoryMb: 4096, diskGb: 20 }, "Run_ABC/123");

    expect(lease.providerLeaseId).toBe("pve/101");
    expect(lease.metadata).toMatchObject({
      provider: "proxmox",
      node: "pve",
      vmid: 101,
      ip: "10.10.0.50",
      remoteCwd: path.join(home, "paperclip-workspace"),
      shellCommand: expect.stringMatching(/^(bash|sh)$/),
      hostKeyAlias: "epaperclip-pve-101",
    });
    expect(lease.metadata!.knownHosts).toMatch(/epaperclip-pve-101 ssh-ed25519/);
    expect(existsSync(path.join(home, "paperclip-workspace"))).toBe(true);

    const clone = pve.find("POST", "/lxc/9000/clone")[0]!;
    expect(clone.form).toMatchObject({ newid: "101", full: "1", pool: "epaperclip", storage: "local-lvm", hostname: "epaperclip-101" });
    const update = pve.find("PUT", "/lxc/101/config")[0]!;
    expect(update.form).toMatchObject({
      cores: "4",
      memory: "4096",
      net0: "name=eth0,bridge=vmbr0,ip=dhcp",
      tags: "epaperclip;company-company-1;run-run_abc-123",
    });
    expect(pve.find("PUT", "/lxc/101/resize")[0]!.form).toMatchObject({ disk: "rootfs", size: "20G" });
    expect(pve.find("POST", "/lxc/101/status/start")).toHaveLength(1);
    expect(pve.containers.get(101)!.status).toBe("running");

    // The first connection learns the host key; later ones must not.
    const detects = shell.calls.filter((c) => c.command.includes("command -v bash"));
    expect(detects.length).toBe(3);
    expect(detects.every((c) => c.acceptNewHostKey)).toBe(true);
    const mkdir = shell.calls.at(-1)!;
    expect(mkdir.acceptNewHostKey).toBeFalsy();
    expect(mkdir.target.knownHosts).toMatch(/fake|FakeHostKey/);
  });

  it("creates from a CT template volid with the derived public key", async () => {
    const lease = await acquire({ template: "local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst", diskGb: 12 });
    expect(lease.providerLeaseId).toBe("pve/101");
    const create = pve.find("POST", /^\/nodes\/pve\/lxc$/)[0]!;
    expect(create.form).toMatchObject({
      vmid: "101",
      ostemplate: "local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst",
      pool: "epaperclip",
      rootfs: "local-lvm:12",
      unprivileged: "1",
      net0: "name=eth0,bridge=vmbr0,ip=dhcp",
      tags: "epaperclip;company-company-1;run-run-1",
    });
    expect(create.form["ssh-public-keys"]).toBe(`${derivePublicKey(key)} epaperclip-proxmox-sandbox`);
  });

  it("surfaces Proxmox's task error and leaves nothing behind", async () => {
    pve.taskFailures.set("vzclone", {
      exitstatus: "clone failed: storage 'fast-ssd' does not exist",
      log: ["create full clone of mountpoint rootfs (local-lvm:base-9000-disk-0)"],
    });
    await expect(acquire()).rejects.toThrow(/clone failed: storage 'fast-ssd' does not exist/);
    expect(pve.containers.has(101)).toBe(false);
  });

  it("removes a half-made container that a failed clone task left behind", async () => {
    pve.taskFailures.set("vzclone", { exitstatus: "clone failed: out of space", log: [], leaveBehind: true });
    await expect(acquire()).rejects.toThrow(/out of space/);
    expect(pve.containers.has(101)).toBe(false);
    expect(pve.find("DELETE", "/lxc/101")).toHaveLength(1);
  });

  it("deletes the new container when it never becomes reachable", async () => {
    shell.failNext(1_000);
    await expect(acquire({ timeoutMs: 1_500 })).rejects.toThrow(/did not become ready.*Connection refused/);
    expect(pve.containers.has(101)).toBe(false);
    expect(pve.find("DELETE", "/lxc/101")[0]!.query).toMatchObject({ purge: "1", "destroy-unreferenced-disks": "1" });
  });

  it("refuses to clone a privileged template", async () => {
    pve.addTemplate(9002, { unprivileged: 0 });
    await expect(acquire({ template: "9002" })).rejects.toThrow(/not safe to clone/);
    expect(pve.find("POST", /clone/)).toHaveLength(0);
  });

  it("retries with a new vmid when another caller took it", async () => {
    pve.racesOnNextId = 1;
    const lease = await acquire();
    expect(pve.find("GET", "/cluster/nextid")).toHaveLength(2);
    expect(pve.find("POST", "/lxc/9000/clone")).toHaveLength(2);
    expect(lease.providerLeaseId).toBe("pve/102");
    expect(pve.containers.get(101)!.config.tags).toBe("someone-else");
  });
});

describe("resume", () => {
  it("resumes a running container without restarting it", async () => {
    const lease = await acquire();
    pve.requests.length = 0;
    const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe("pve/101");
    expect(resumed.metadata).toMatchObject({ resumedLease: true, remoteCwd: lease.metadata!.remoteCwd });
    expect(pve.find("POST", /status\/start/)).toHaveLength(0);
    // Resume checks the recorded host key instead of learning a new one.
    expect(shell.calls.at(-2)!.acceptNewHostKey).toBe(false);
  });

  it("starts a stopped container", async () => {
    const lease = await acquire();
    pve.containers.get(101)!.status = "stopped";
    const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe("pve/101");
    expect(pve.containers.get(101)!.status).toBe("running");
  });

  it("reports a deleted container as expired", async () => {
    const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: config(), providerLeaseId: "pve/4242" });
    expect(resumed).toEqual({ providerLeaseId: null, metadata: { expired: true } });
  });

  it("treats a reused vmid that is not ours as expired", async () => {
    pve.addContainer(300, { config: { tags: "production" } });
    const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: config(), providerLeaseId: "pve/300" });
    expect(resumed.providerLeaseId).toBeNull();
  });
});

describe("execute", () => {
  let lease: PluginEnvironmentLease;
  beforeEach(async () => {
    lease = await acquire();
  });

  it("runs the command with args, env, cwd and stdin", async () => {
    const result = await hooks.onEnvironmentExecute!({
      ...base,
      config: config(),
      lease,
      command: "sh",
      args: ["-c", 'printf "%s|%s|" "$GREETING" "$(pwd)"; cat'],
      env: { GREETING: "hello" },
      stdin: "from-stdin",
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: `hello|${lease.metadata!.remoteCwd}|from-stdin` });
  });

  it("is injection-safe for env values, cwd and args", async () => {
    const hostile = [`it's "quoted"`, "$HOME and ${PATH}", "`touch backtick-pwned`", "$(touch subst-pwned)", "line1\nline2\n", "'; touch semicolon-pwned; '", "\\back\\slash"];
    const cwd = path.join(home, `dir with 'quote' $(touch cwd-pwned) \`x\`\nnewline`);
    mkdirSync(cwd, { recursive: true });
    const env = Object.fromEntries(hostile.map((value, i) => [`V${i}`, value]));
    const result = await hooks.onEnvironmentExecute!({
      ...base,
      config: config(),
      lease,
      command: "node",
      args: ["-e", `process.stdout.write(JSON.stringify({ env: [${hostile.map((_, i) => `process.env.V${i}`).join(",")}], cwd: process.cwd(), arg: process.argv[1] }))`, "$(touch arg-pwned) '\"`"],
      cwd,
      env,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.env).toEqual(hostile);
    expect(parsed.cwd).toBe(cwd);
    expect(parsed.arg).toBe("$(touch arg-pwned) '\"`");
    for (const marker of ["backtick-pwned", "subst-pwned", "semicolon-pwned", "cwd-pwned", "arg-pwned"]) {
      expect(existsSync(path.join(cwd, marker))).toBe(false);
      expect(existsSync(path.join(home, marker))).toBe(false);
      expect(existsSync(path.join(lease.metadata!.remoteCwd as string, marker))).toBe(false);
    }
  });

  it("refuses environment variable names that are not identifiers", async () => {
    const result = await hooks.onEnvironmentExecute!({ ...base, config: config(), lease, command: "true", env: { "BAD;touch x": "1" } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Invalid environment variable name/);
    expect(() => buildExecScript({ command: "true", args: [], env: { "A B": "x" }, execId: "id" })).toThrow();
  });

  it("returns non-zero exit codes and stderr", async () => {
    const result = await hooks.onEnvironmentExecute!({ ...base, config: config(), lease, command: "sh", args: ["-c", "echo oops >&2; exit 7"] });
    expect(result).toMatchObject({ exitCode: 7, timedOut: false, stderr: "oops\n" });
  });

  it("kills the whole remote command on timeout", async () => {
    const pidFile = path.join(home, "child.pid");
    const started = Date.now();
    const result = await hooks.onEnvironmentExecute!({
      ...base,
      config: config(),
      lease,
      command: "sh",
      args: ["-c", `echo $$ > '${pidFile}'; exec sleep 30`],
      timeoutMs: 700,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(processIsGone(pid)).toBe(true);
    // The kill went out as its own ssh call.
    expect(shell.calls.at(-1)!.command).toMatch(/kill -TERM/);
  });

  it("streams output through ctx.execution.log when the host provides it", async () => {
    const chunks: Array<[string, string]> = [];
    await plugin.definition.setup({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      execution: { log: (stream: "stdout" | "stderr", chunk: string) => chunks.push([stream, chunk]) },
    } as unknown as PluginContext);
    const result = await hooks.onEnvironmentExecute!({ ...base, config: config(), lease, command: "sh", args: ["-c", "echo one; echo two >&2"] });
    expect(chunks.filter(([s]) => s === "stdout").map(([, c]) => c).join("")).toBe(result.stdout);
    expect(chunks.filter(([s]) => s === "stderr").map(([, c]) => c).join("")).toBe(result.stderr);
  });

  it("answers without a lease", async () => {
    const result = await hooks.onEnvironmentExecute!({ ...base, config: config(), lease: { providerLeaseId: null }, command: "true" });
    expect(result.exitCode).toBe(1);
  });
});

describe("realize workspace", () => {
  it("creates the workspace and returns it as cwd", async () => {
    const lease = await acquire();
    const target = path.join(home, "ws", "nested dir");
    const result = await hooks.onEnvironmentRealizeWorkspace!({
      ...base,
      config: config(),
      lease: { ...lease, metadata: { ...lease.metadata, remoteCwd: target } },
      workspace: { mode: "isolated_workspace" },
    });
    expect(result.cwd).toBe(target);
    expect(existsSync(target)).toBe(true);
  });
});

describe("release, stop and destroy", () => {
  it("shuts down and deletes on release", async () => {
    const lease = await acquire();
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    expect(receipt).toEqual({ providerLeaseId: "pve/101", state: "destroyed" });
    expect(pve.find("POST", "/lxc/101/status/shutdown")[0]!.form).toMatchObject({ forceStop: "1" });
    expect(pve.find("DELETE", "/lxc/101")[0]!.query).toEqual({ purge: "1", "destroy-unreferenced-disks": "1" });
    expect(pve.containers.has(101)).toBe(false);
  });

  it("keeps the container running on release when leases are reused", async () => {
    const lease = await acquire({ reuseLease: true });
    pve.requests.length = 0;
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: config({ reuseLease: true }), providerLeaseId: lease.providerLeaseId });
    expect(receipt).toBeUndefined();
    expect(pve.requests).toHaveLength(0);
    expect(pve.containers.get(101)!.status).toBe("running");
  });

  it("stops and keeps the container for stop_and_retain and onEnvironmentStopLease", async () => {
    const lease = await acquire();
    const receipt = await hooks.onEnvironmentReleaseLease!({
      ...base,
      config: config(),
      providerLeaseId: lease.providerLeaseId,
      resourceDisposition: "stop_and_retain",
    });
    expect(receipt).toEqual({ providerLeaseId: "pve/101", state: "stopped" });
    expect(pve.containers.get(101)!.status).toBe("stopped");
    expect(pve.find("DELETE", "/lxc/101")).toHaveLength(0);

    const again = await hooks.onEnvironmentStopLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId });
    expect(again.state).toBe("stopped");
    await expect(hooks.onEnvironmentStopLease!({ ...base, config: config(), providerLeaseId: "pve/999" })).rejects.toThrow(/no longer exists/);
  });

  it("destroy is idempotent", async () => {
    const lease = await acquire();
    const first = await hooks.onEnvironmentDestroyLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId, cancelActiveWork: true });
    expect(first).toEqual({ providerLeaseId: "pve/101", state: "destroyed" });
    expect(pve.find("POST", "/lxc/101/status/stop")).toHaveLength(1); // cancelActiveWork stops hard
    const second = await hooks.onEnvironmentDestroyLease!({ ...base, config: config(), providerLeaseId: lease.providerLeaseId });
    expect(second).toEqual({ providerLeaseId: "pve/101", state: "destroyed" });
    expect(pve.find("DELETE", "/lxc/101")).toHaveLength(1);
    expect(await hooks.onEnvironmentDestroyLease!({ ...base, config: config(), providerLeaseId: null })).toBeUndefined();
  });

  it("still cleans up after the rest of the environment config became invalid", async () => {
    const lease = await acquire();
    const broken = config({ template: "", pool: "", sshPrivateKey: "" });
    const receipt = await hooks.onEnvironmentDestroyLease!({ ...base, config: broken, providerLeaseId: lease.providerLeaseId });
    expect(receipt).toEqual({ providerLeaseId: "pve/101", state: "destroyed" });
    expect(pve.containers.has(101)).toBe(false);
  });

  it("never deletes a container it does not own, or a template", async () => {
    pve.addContainer(300, { config: { tags: "production" } });
    pve.addContainer(301, { config: { tags: "epaperclip;company-other-co;run-x" } });
    for (const id of ["pve/300", "pve/301", "pve/9000"]) {
      const receipt = await hooks.onEnvironmentDestroyLease!({ ...base, config: config(), providerLeaseId: id });
      expect(receipt).toMatchObject({ state: "destroyed" });
    }
    expect(pve.containers.has(300)).toBe(true);
    expect(pve.containers.has(301)).toBe(true);
    expect(pve.containers.has(9000)).toBe(true);
    expect(pve.find("DELETE", /lxc\/\d+$/)).toHaveLength(0);
  });
});

describe("tags", () => {
  it("sanitises ids into valid Proxmox tags", () => {
    expect(sanitizeTag("company-ABC_def/1.2")).toBe("company-abc_def-1.2");
    expect(sanitizeTag("--weird")).toBe("weird");
    expect(buildTags("0b9c3d6e-1f2a-4b5c-8d7e-9f0a1b2c3d4e", "run 1")).toBe("epaperclip;company-0b9c3d6e-1f2a-4b5c-8d7e-9f0a1b2c3d4e;run-run-1");
  });
});

function processIsGone(pid: number): boolean {
  const deadline = Date.now() + 5_000;
  for (;;) {
    let state: string | null = null;
    try {
      state = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] ?? null;
    } catch {
      return true;
    }
    if (state === "Z" || state === "X") return true; // exited, waiting to be reaped
    if (Date.now() > deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

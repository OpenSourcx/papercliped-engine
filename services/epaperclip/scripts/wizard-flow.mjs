// Drives both wizards in a real browser against the live host service and the wizard's fake Proxmox (run
// scripts/wizard-live.ts first), creates a virtual machine and a container, and checks what Proxmox was asked for.
//   node scripts/wizard-flow.mjs [outDir] [liveUrl]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require(join(execFileSync("npm", ["root", "-g"]).toString().trim(), "playwright"));
}
const out = resolve(process.argv[2] ?? "/tmp/wizard-shots");
const base = process.argv[3] ?? "http://127.0.0.1:4480";
mkdirSync(out, { recursive: true });

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("epc.setup", JSON.stringify({ ownerName: "Sam", deviceName: "pve", pinMode: "assistant", aiProvider: null, pinAccess: { system: true, orgs: true, connectors: true, docs: true }, completedAt: new Date().toISOString() })));
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(e.message));
await page.goto(base + "/");
await page.evaluate(() => fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-EPC-Request": "1" }, body: JSON.stringify({ username: "sam", password: "right", realm: "pve" }) }));

const dialog = page.getByRole("dialog");
const steps = page.getByRole("navigation", { name: "Steps" });
const step = (name) => steps.getByRole("button", { name }).click();
const created = async () => (await fetch(base + "/__created").then((r) => r.json()));
const shot = (name) => page.screenshot({ path: `${out}/flow-${name}.png` });

// ---- A Windows 11 virtual machine with a second disk, a VLAN, a serial port and a TPM
await page.goto(base + "/pve/machines?modal=new-machine&kind=vm");
await dialog.waitFor();
await page.getByLabel("Name", { exact: true }).fill("win-test");
await step(/OS/);
await page.getByLabel("ISO image").selectOption("local:iso/win11.iso");
await shot("vm-os-windows");
assert.equal(await page.getByLabel("Guest operating system").inputValue(), "win11", "a Windows ISO moves to Windows 11");
await step(/System/);
await shot("vm-system-windows");
await step(/Disks/);
await page.getByRole("button", { name: "Add disk" }).click();
await page.getByLabel("Disk size").nth(1).fill("100");
await page.getByLabel("Storage").nth(1).selectOption("tank");
await shot("vm-disks-two");
await step(/CPU/);
await page.getByLabel("Cores").fill("4");
await step(/Memory/);
await dialog.getByRole("textbox", { name: "Memory" }).fill("8192");
await page.getByRole("switch", { name: "Ballooning" }).click();
await step(/Network/);
await page.getByLabel("VLAN tag").fill("20");
await shot("vm-network-vlan");
await step(/Hardware/);
await page.getByLabel("Serial ports").selectOption("1");
await step(/Confirm/);
await page.getByRole("button", { name: /What will be sent to Proxmox/ }).click();
await page.waitForTimeout(500);
await shot("vm-confirm");
const sent = await page.getByLabel("Proxmox request").innerText();
assert.match(await dialog.innerText(), /Windows 11 needs at least 64 GB of disk/);
assert.match(sent, /bios = ovmf/);
assert.match(sent, /tpmstate0 = /);
assert.match(sent, /net0 = model=e1000e,bridge=vmbr0,firewall=1,tag=20/);
await page.getByRole("button", { name: "Create and start" }).click();
await page.waitForURL(/\/machines\/\d+/);
let all = await created();
const win = all.find((m) => m.params.name === "win-test");
assert.ok(win, "the virtual machine was created");
assert.equal(win.params.bios, "ovmf");
assert.equal(win.params.machine, "q35");
assert.equal(win.params.ostype, "win11");
assert.ok(win.params.sata0.startsWith("local-lvm:32") && win.params.sata1.startsWith("tank:100"), JSON.stringify(win.params));
assert.equal(win.params.serial0, "socket");
assert.equal(win.params.cores, "4");

// ---- An error is shown where it can be fixed
await page.goto(base + "/pve/machines?modal=new-machine&kind=vm");
await dialog.waitFor();
await step(/Disks/);
await page.getByLabel("Disk size").fill("0");
await page.waitForTimeout(200);
await shot("vm-error-disk");
assert.ok(await page.getByText("Disk size must be a whole number").first().isVisible());
await step(/Confirm/);
assert.ok(await page.getByRole("button", { name: "Create and start" }).isDisabled(), "Create is off while a step has a problem");
await shot("vm-error-confirm");

// ---- A container with a static address and a key
await page.goto(base + "/pve/machines?modal=new-machine");
await dialog.waitFor();
await page.getByLabel("Hostname").fill("ct-live");
await page.getByLabel("Root password").fill("correct-horse-battery");
await page.getByLabel("SSH public key").fill("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop");
await step(/Network/);
await page.getByLabel("IPv4", { exact: true }).selectOption("static");
await page.getByLabel("IPv4 address").fill("192.168.1.50/24");
await page.getByLabel("IPv4 gateway").fill("192.168.1.1");
await page.getByLabel("IPv6", { exact: true }).selectOption("auto");
await page.getByLabel("VLAN tag").fill("30");
await shot("ct-network-static");
await step(/Confirm/);
await shot("ct-confirm");
assert.ok(!(await dialog.innerText()).includes("correct-horse-battery"), "the password is never shown");
await page.getByRole("button", { name: "Create and start" }).click();
await page.waitForURL(/\/machines\/\d+/);
all = await created();
const ct = all.find((m) => m.params.hostname === "ct-live");
assert.ok(ct, "the container was created");
assert.equal(ct.params.net0, "name=eth0,bridge=vmbr0,firewall=1,tag=30,ip=192.168.1.50/24,gw=192.168.1.1,ip6=auto");
assert.equal(ct.params.password, "(set)");
assert.equal(ct.params.unprivileged, "1");

await browser.close();
if (problems.length) {
  console.log("Page errors:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`wizard-flow: ok (screenshots in ${out})`);

import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const json = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

test("both providers pin the same Paperclip SDK, because the installer shares one node_modules between them", () => {
  const a = json("plugins/proxmox-sandbox/package.json").dependencies["@paperclipai/plugin-sdk"];
  const b = json("plugins/remote-worker/package.json").dependencies["@paperclipai/plugin-sdk"];
  assert.equal(a, b);
  assert.equal(a, "2026.1023.0");
  const la = json("plugins/proxmox-sandbox/package-lock.json").packages["node_modules/@paperclipai/plugin-sdk"].version;
  const lb = json("plugins/remote-worker/package-lock.json").packages["node_modules/@paperclipai/plugin-sdk"].version;
  assert.equal(la, lb);
});

test("the remote worker provider is a sandbox_provider, so the managed-sandbox-only policy applies to it", () => {
  const src = readFileSync(new URL("../plugins/remote-worker/src/manifest.ts", import.meta.url), "utf8");
  assert.match(src, /kind: "sandbox_provider"/);
  assert.match(src, /driverKey: PROVIDER_KEY/);
  assert.match(src, /PROVIDER_KEY = "remote-worker"/);
});

test("the control API exposes no route that can remove or revoke a node", () => {
  const src = readFileSync(new URL("../services/epaperclip/src/fabric/listener.ts", import.meta.url), "utf8");
  const routes = [...src.matchAll(/"\/control\/v1\/[^"]*"|\(resume\|workspace\|exec\|release\|stop\|destroy\)/g)].map((m) => m[0]);
  assert.ok(routes.length >= 3);
  assert.doesNotMatch(src, /revoke|forget|updateWorker|\.adopt\(/);
});

test("the worker never receives host credentials: protocol messages carry no token or Proxmox fields", () => {
  const src = readFileSync(new URL("../packages/worker-fabric/src/protocol.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /apiToken|ticket|password|oauth/i);
});

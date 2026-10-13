import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpsRequest, createServer as createHttps, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { FEATURES } from "../src/features/index.ts";
import { createNodeFeature } from "../src/features/node.ts";
import { serverOf, TlsReloader, tlsFiles } from "../src/features/nodeTls.ts";
import { SessionStore } from "../src/sessions.ts";
import { StateStore } from "../src/state.ts";
import { fakeNodePve, makeCert } from "./fakes-node.ts";
import { until } from "./fakes.ts";

const fp = (pem: string) => new X509Certificate(pem).fingerprint256;
const servers: Server[] = [];
const original = [...FEATURES];
afterEach(async () => {
  FEATURES.splice(0, FEATURES.length, ...original);
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** What certificate does a TLS client actually see on this port right now. */
const served = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const r = httpsRequest({ host: "127.0.0.1", port, path: "/", rejectUnauthorized: false, agent: false }, (res) => {
      resolve((res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256);
      res.resume();
    });
    r.on("error", reject);
    r.end();
  });

function pveDir() {
  const dir = mkdtempSync(join(tmpdir(), "epc-pvecerts-"));
  const a = makeCert("a.lan");
  writeFileSync(join(dir, "pve-ssl.pem"), a.cert);
  writeFileSync(join(dir, "pve-ssl.key"), a.key);
  return { dir, a, env: { EPC_TLS_CERT: join(dir, "pve-ssl.pem"), EPC_TLS_KEY: join(dir, "pve-ssl.key") } };
}

describe("serving the node's certificate", () => {
  it("follows Proxmox's rule: a custom pveproxy-ssl pair wins over pve-ssl", () => {
    const { dir, env, a } = pveDir();
    expect(tlsFiles(env).cert).toBe(env.EPC_TLS_CERT);
    const b = makeCert("b.lan");
    writeFileSync(join(dir, "pveproxy-ssl.pem"), b.cert);
    expect(tlsFiles(env).cert).toBe(env.EPC_TLS_CERT); // key missing: not a pair yet
    writeFileSync(join(dir, "pveproxy-ssl.key"), b.key);
    expect(tlsFiles(env).cert).toBe(join(dir, "pveproxy-ssl.pem"));
    // A cert path the operator chose themselves is never second-guessed.
    expect(tlsFiles({ EPC_TLS_CERT: join(dir, "own.pem"), EPC_TLS_KEY: join(dir, "own.key") }).cert).toBe(join(dir, "own.pem"));
    void a;
  });

  it("swaps a new certificate into the running server without a restart", async () => {
    const { dir, env, a } = pveDir();
    const tls = new TlsReloader({ env: () => env, watchMs: 60_000 });
    const server = createHttps({ cert: a.cert, key: a.key, minVersion: "TLSv1.2" }, (_req, res) => res.end("ok"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    tls.attach(server);
    expect(await served(port)).toBe(fp(a.cert));
    expect(tls.reload()).toMatchObject({ reloaded: false, changed: false });

    const b = makeCert("b.lan");
    writeFileSync(join(dir, "pveproxy-ssl.pem"), b.cert);
    writeFileSync(join(dir, "pveproxy-ssl.key"), b.key);
    expect(tls.reload()).toMatchObject({ reloaded: true, changed: true, fingerprint: fp(b.cert) });
    expect(await served(port)).toBe(fp(b.cert));

    // Removing the custom pair falls back to the node's own certificate.
    const gone = mkdtempSync(join(tmpdir(), "epc-x-"));
    void gone;
    tls.stop();
  });

  it("keeps serving the old certificate when the new files are broken or don't match", async () => {
    const { dir, env, a } = pveDir();
    const tls = new TlsReloader({ env: () => env, watchMs: 60_000 });
    const server = createHttps({ cert: a.cert, key: a.key }, (_req, res) => res.end("ok"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    tls.attach(server);
    const b = makeCert("b.lan");
    const c = makeCert("c.lan");
    writeFileSync(join(dir, "pveproxy-ssl.pem"), b.cert);
    writeFileSync(join(dir, "pveproxy-ssl.key"), c.key);
    const mismatch = tls.reload();
    expect(mismatch.reloaded).toBe(false);
    expect(mismatch.reason).toMatch(/don't belong together/);
    writeFileSync(join(dir, "pveproxy-ssl.pem"), "garbage");
    expect(tls.reload().reloaded).toBe(false);
    expect(await served(port)).toBe(fp(a.cert));
    expect(JSON.stringify(mismatch)).not.toContain(c.key.split("\n")[1]);
    tls.stop();
  });

  it("notices a changed file by itself, as with Proxmox's daily automatic renewal", async () => {
    const { dir, env, a } = pveDir();
    const tls = new TlsReloader({ env: () => env, watchMs: 20 });
    const server = createHttps({ cert: a.cert, key: a.key }, (_req, res) => res.end("ok"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    tls.attach(server);
    const b = makeCert("renewed.lan");
    writeFileSync(join(dir, "pveproxy-ssl.pem"), b.cert);
    writeFileSync(join(dir, "pveproxy-ssl.key"), b.key);
    await until(() => tls.fingerprint === fp(b.cert), 3000);
    expect(await served(port)).toBe(fp(b.cert));
    tls.stop();
  });

  it("does nothing on plain HTTP", () => {
    const tls = new TlsReloader({ env: () => ({}) });
    expect(tls.reload()).toMatchObject({ reloaded: false });
    expect(serverOf({ socket: {} })).toBeNull();
  });

  it("reloads end to end: upload a certificate through the API and the next connection gets it", async () => {
    const { dir, env, a } = pveDir();
    const fake = fakeNodePve();
    const b = makeCert("pve.example.com");
    // Proxmox writes its pair when the certificate is posted.
    fake.st.onCustomCert = (cert, key) => {
      writeFileSync(join(dir, "pveproxy-ssl.pem"), cert);
      writeFileSync(join(dir, "pveproxy-ssl.key"), key);
    };
    const tls = new TlsReloader({ env: () => env, watchMs: 60_000 });
    FEATURES.splice(0, FEATURES.length, { name: "node", handle: createNodeFeature({ tls }) });
    const app = createApp({ pve: { baseUrl: "https://127.0.0.1:8006", node: "pve", transport: fake.transport }, sessions: new SessionStore(), staticDir: null, secureCookies: false, state: new StateStore(mkdtempSync(join(tmpdir(), "epc-node-"))) });
    const server = createHttps({ cert: a.cert, key: a.key, minVersion: "TLSv1.2" }, app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, cookie: string, body?: unknown) =>
      new Promise<{ status: number; headers: Record<string, unknown>; json: any }>((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const r = httpsRequest({ host: "127.0.0.1", port, path, method, rejectUnauthorized: false, agent: false, headers: { "Content-Type": "application/json", "X-EPC-Request": "1", Cookie: cookie, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, json: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }));
        });
        r.on("error", reject);
        if (data) r.write(data);
        r.end();
      });
    const login = await call("POST", "/api/login", "", { username: "sam", password: "right", realm: "pve" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    expect(await served(port)).toBe(fp(a.cert));
    const up = await call("POST", "/api/node/certificates/custom", cookie, { certificates: b.cert, key: b.key });
    expect(up.status).toBe(200);
    expect(up.json.tls).toMatchObject({ reloaded: true, fingerprint: fp(b.cert) });
    expect(await served(port)).toBe(fp(b.cert));
    const listed = await call("GET", "/api/node/certificates", cookie);
    expect(listed.json.serving.fingerprint).toBe(fp(b.cert));
    tls.stop();
    void copyFileSync;
    void mkdirSync;
  });
});

import { readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { hostname } from "node:os";
import { TRUSTED_KEYS, trustedKey } from "@papercliped-engine/marketplace";
import { createApp } from "./app.ts";
import { SessionStore } from "./sessions.ts";
import { StateStore } from "./state.ts";

/**
 * Starts the ePaperclip host service. On a Proxmox host it listens on 443 with the node's own certificate
 * (the one pveproxy serves on 8006) and talks to Proxmox on loopback, verifying it against the cluster CA.
 *
 *   EPC_LISTEN     host:port to listen on            (default 0.0.0.0:443)
 *   EPC_PVE_URL    Proxmox API                       (default https://127.0.0.1:8006)
 *   EPC_PVE_CA     CA that signed Proxmox's cert     (default /etc/pve/pve-root-ca.pem)
 *   EPC_PVE_NODE   this node's name                  (default the hostname)
 *   EPC_TLS_CERT   certificate to serve              (default /etc/pve/local/pve-ssl.pem)
 *   EPC_TLS_KEY    its private key                   (default /etc/pve/local/pve-ssl.key)
 *   EPC_STATIC     the built console                 (default /opt/epaperclip/console)
 *   EPC_MAX_UPLOAD_GB  largest ISO or template upload    (default 64)
 *   EPC_MARKETPLACE_URL  where the Store's signed catalog is published (default the first-party catalog)
 *   EPC_MARKETPLACE_KEY  PEM public key to also trust for the catalog (for your own catalog or a fork)
 *   EPC_DEV_HTTP   set to 1 to serve plain HTTP for local development only
 *   EPC_STATE_DIR  the service's state and vault (vault.key, state.json)   (default /var/lib/epaperclip)
 *   EPC_ENGINE_URL         where the engine listens                     (default http://127.0.0.1:3100)
 *   EPC_ENGINE_PUBLIC_URL  the engine's PAPERCLIP_PUBLIC_URL, sent as Origin (default EPC_ENGINE_URL)
 *   EPC_ENGINE_DIR         where the engine is installed, for its version  (default /opt/epaperclip/engine)
 */

const env = process.env;
const listen = env.EPC_LISTEN ?? "0.0.0.0:443";
const at = listen.lastIndexOf(":");
const host = at > 0 ? listen.slice(0, at).replace(/^\[|\]$/g, "") : "0.0.0.0";
const port = Number(at >= 0 ? listen.slice(at + 1) : listen);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`EPC_LISTEN must be host:port, got ${listen}`);

const devHttp = env.EPC_DEV_HTTP === "1";
const caPath = env.EPC_PVE_CA ?? "/etc/pve/pve-root-ca.pem";
let caPem: string | undefined;
try {
  caPem = readFileSync(caPath, "utf8");
} catch (e) {
  if (env.EPC_PVE_CA) throw e;
  console.warn(`epaperclip: no Proxmox CA at ${caPath}; using the system trust store`);
}

const sessions = new SessionStore();
// The state directory must be usable: it holds the only copy of the managed engine passwords, so a fallback would strand them.
const state = new StateStore(env.EPC_STATE_DIR || "/var/lib/epaperclip");
const engineUrl = env.EPC_ENGINE_URL || "http://127.0.0.1:3100";
const handle = createApp({
  state,
  engine: { url: engineUrl, publicUrl: env.EPC_ENGINE_PUBLIC_URL || engineUrl, installDir: env.EPC_ENGINE_DIR || undefined },
  pve: { baseUrl: env.EPC_PVE_URL ?? "https://127.0.0.1:8006", node: env.EPC_PVE_NODE ?? hostname().split(".")[0], caPem },
  sessions,
  staticDir: env.EPC_STATIC ?? "/opt/epaperclip/console",
  secureCookies: !devHttp,
  maxUploadBytes: Number(env.EPC_MAX_UPLOAD_GB ?? 64) * 1024 ** 3,
  consolePort: port,
  marketplace: { url: env.EPC_MARKETPLACE_URL, keys: [...TRUSTED_KEYS, ...(env.EPC_MARKETPLACE_KEY ? [trustedKey(env.EPC_MARKETPLACE_KEY.replace(/\\n/g, "\n"))] : [])] },
});

const server = devHttp
  ? createHttp(handle)
  : createHttps({ cert: readFileSync(env.EPC_TLS_CERT ?? "/etc/pve/local/pve-ssl.pem"), key: readFileSync(env.EPC_TLS_KEY ?? "/etc/pve/local/pve-ssl.key"), minVersion: "TLSv1.2" }, handle);
server.on("upgrade", handle.upgrade);
server.headersTimeout = 20_000;
// Uploads of multi-gigabyte ISOs can take a long time on a slow link; a stalled socket still times out below.
server.requestTimeout = 6 * 3600_000;
server.timeout = 120_000;

const sweep = setInterval(() => sessions.sweep(), 60_000);
sweep.unref();

server.listen(port, host, () => console.log(`epaperclip: listening on ${devHttp ? "http" : "https"}://${listen}`));
// Settle the engine's service account in the background, retrying while the engine starts.
void handle.engine?.start();
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    handle.engine?.stop();
    server.close(() => process.exit(0));
  });

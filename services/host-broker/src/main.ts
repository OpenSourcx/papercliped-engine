import { appendFileSync, readFileSync } from "node:fs";
import { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { Broker } from "./broker.ts";
import { parseBrokerConfig } from "./config.ts";
import { startServer } from "./server.ts";

// Usage: PROXMOX_TOKEN_SECRET=... node --experimental-strip-types src/main.ts /etc/papercliped/broker.json
const path = process.argv[2] ?? "/etc/papercliped/broker.json";
const config = parseBrokerConfig(JSON.parse(readFileSync(path, "utf8")), process.env);

const pve = new ProxmoxClient({ baseUrl: config.proxmox.url, tokenId: config.proxmox.tokenId, tokenSecret: config.proxmox.tokenSecret, caPem: config.proxmox.caPem });
const broker = new Broker({ config, pve, audit: (e) => appendFileSync(config.auditLog, `${JSON.stringify(e)}\n`, { mode: 0o600 }) });

startServer(broker, config.principals, config.listen);
console.log(`host broker listening on ${config.listen.host}:${config.listen.port}`);

const sweep = () => broker.reapExpired().then((r) => r.length && console.log(`reaped expired leases: ${r.join(", ")}`)).catch((e) => console.error(`reaper: ${e instanceof Error ? e.message : e}`));
setInterval(sweep, 60_000).unref();
void sweep();

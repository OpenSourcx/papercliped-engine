import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateIdentity, type Identity } from "@papercliped-engine/worker-fabric";

/** The worker's files: `identity.json` (secret, 0600) and `config.json`, in one directory owned by the service user. */

export interface WorkerConfig {
  version: 1;
  hostKey: string | null;
  endpoints: { provider: string; url: string }[];
  workerId: string | null;
  name: string;
  workspaceRoot: string;
  /** Preferred transport provider when several endpoints are known. */
  prefer: string | null;
  /** Ollama (or compatible) URL on this node; empty means detect. */
  ollamaUrl: string;
  inference: { gatePort: number; slots: number; maxContext: number | null };
  revoked: boolean;
  /** Who executes setup steps after pairing: Pin through the helper, or the person with Pin's guidance. */
  setupMode: "pin" | "self" | null;
  /** A pairing code's id and secret, kept only until the first successful connection. */
  pairing: { id: string; secret: string } | null;
}

export const DEFAULT_DIR = "/var/lib/epaperclip-worker";

export const defaults = (dir: string): WorkerConfig => ({
  version: 1, hostKey: null, endpoints: [], workerId: null, name: "", workspaceRoot: process.env.EPW_WORKSPACES || "/workspaces", prefer: null, ollamaUrl: "",
  inference: { gatePort: 11435, slots: 1, maxContext: null }, revoked: false, setupMode: null, pairing: null,
});

function writeAtomic(file: string, text: string, mode: number) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export class WorkerFiles {
  readonly dir: string;
  constructor(dir: string = process.env.EPW_DIR || DEFAULT_DIR) {
    this.dir = dir;
  }
  config(): WorkerConfig {
    const f = join(this.dir, "config.json");
    if (!existsSync(f)) return defaults(this.dir);
    return { ...defaults(this.dir), ...(JSON.parse(readFileSync(f, "utf8")) as Partial<WorkerConfig>) };
  }
  saveConfig(c: WorkerConfig) {
    writeAtomic(join(this.dir, "config.json"), JSON.stringify(c, null, 2), 0o640);
  }
  /** Loads the machine key, creating it on first use. The file is never readable by other users. */
  identity(): Identity {
    const f = join(this.dir, "identity.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Identity;
    const id = generateIdentity();
    writeAtomic(f, JSON.stringify(id), 0o600);
    return id;
  }
}

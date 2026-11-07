import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { BrokerConfig, ResourceGroup } from "./config.ts";
import { Broker, BrokerError } from "./broker.ts";

/**
 * The broker's small durable control plane. It intentionally persists only organization policy;
 * caller tokens and the Proxmox token remain in service environment/secret storage.
 */
export class GroupRegistry {
  private readonly path: string;
  private readonly broker: Broker;

  constructor(broker: Broker, config: BrokerConfig) {
    this.broker = broker;
    this.path = config.stateFile;
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { format?: unknown; groups?: unknown };
      if (parsed.format !== 1) throw new Error("unsupported registry format");
      this.broker.replaceGroups(parsed.groups);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        // Seed the durable registry with the reviewed static groups on first boot.
        this.save(this.broker.groups());
        return;
      }
      throw new Error(`couldn't load broker group registry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  groups() {
    return this.broker.groups();
  }

  replace(groups: unknown): Record<string, ResourceGroup> {
    return this.broker.replaceGroups(groups, (next) => this.save(next));
  }

  private save(groups: Record<string, ResourceGroup>) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ format: 1, groups })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.path);
    } catch (error) { rmSync(temp, { force: true }); throw error; }
    try { const fd = openSync(dirname(this.path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* Filesystems may not support directory fsync. The rename has completed. */ }
  }
}

export function registryError(error: unknown): BrokerError {
  return error instanceof BrokerError ? error : new BrokerError(error instanceof Error ? error.message : "Invalid resource-group registry", 400, "bad_group_registry");
}

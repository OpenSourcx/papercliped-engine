import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import type { EngineGateway } from "../engine.ts";
import type { HttpError } from "../http.ts";
import type { Session } from "../sessions.ts";
import type { StateStore } from "../state.ts";
import { handleCluster } from "./cluster.ts";
import { handleDisks } from "./disks.ts";
import { handleGuest } from "./guest.ts";
import { nodeFeature } from "./node.ts";
import { access } from "./access.ts";
import { handleWizard } from "./wizard.ts";
import { handlePin } from "./pin.ts";
import { handleNotes } from "./notes.ts";
import { handleStorageTools } from "./storageTools.ts";
import { handleBackupTools } from "./backupTools.ts";
import { handleDiskHealth } from "./diskHealth.ts";

/**
 * Where new areas of the host service go. A feature is one file in this folder that exports a handler; adding it to
 * FEATURES below is the only change needed elsewhere, so several areas can be built side by side. A handler looks at
 * the request, and either answers it and returns true, or returns false so the next one (and finally the 404) can.
 *
 * Rules every feature follows: sign-in is required (`ctx.asUser`/`ctx.session`), changes need `ctx.sameSite()`, the work
 * is done through the Proxmox API as the signed-in person so Proxmox's own permissions decide, input is validated
 * before anything reaches Proxmox, and nothing secret is ever returned or logged.
 */
export interface FeatureCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  path: string;
  /** The node this host service runs on. Features that take a node parameter must validate it against the cluster. */
  node: string;
  state: StateStore;
  gateway: EngineGateway | null;
  /** The signed-in session, or a 401 HttpError. */
  session(): Session;
  /** Runs `fn` as the signed-in person against Proxmox; a Proxmox 401 ends their session, a 403 becomes a clear error. */
  asUser<T>(fn: (pve: ProxmoxClient, s: Session) => Promise<T>): Promise<T>;
  /** Throws unless this is one of our own pages making the request. Call it first on every change. */
  sameSite(): void;
  /** Whether the signed-in person administers this node (Sys.Modify on "/"). */
  isNodeAdmin(pve: ProxmoxClient): Promise<boolean>;
  readJson(max?: number): Promise<Record<string, unknown>>;
  json(status: number, body: unknown, headers?: Record<string, string | string[]>): void;
  now(): number;
  HttpError: typeof HttpError;
}

export type FeatureHandler = (ctx: FeatureCtx) => Promise<boolean>;

export const FEATURES: { name: string; handle: FeatureHandler }[] = [
  { name: "disks", handle: handleDisks },
  { name: "node", handle: nodeFeature },
  { name: "access", handle: access },
  { name: "wizard", handle: handleWizard },
  { name: "guest", handle: handleGuest },
  { name: "cluster", handle: handleCluster },
  { name: "pin", handle: handlePin },
  { name: "notes", handle: handleNotes },
  { name: "storage-tools", handle: handleStorageTools },
  { name: "backup-tools", handle: handleBackupTools },
  { name: "disk-health", handle: handleDiskHealth },
];

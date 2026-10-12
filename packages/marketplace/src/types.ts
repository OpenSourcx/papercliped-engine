/** The catalog's shapes, with no code behind them, so the console can use them too. */

export const SCHEMA = 1;
export const CONNECTOR_KINDS = ["model", "code", "chat", "mail", "storage", "network"] as const;

export type EntryKind = "connector" | "adapter" | "skill";

export type Source =
  /** Ships with ePaperclip or Paperclip; nothing to download. */
  | { type: "builtin" }
  /** An npm package, pinned to an exact version and the registry's integrity hash. */
  | { type: "npm"; name: string; version: string; integrity: string };

export interface Entry {
  id: string;
  kind: EntryKind;
  name: string;
  vendor: string;
  summary: string;
  version: string;
  /** The oldest ePaperclip this works with. */
  minEngine?: string;
  connectorKind?: (typeof CONNECTOR_KINDS)[number];
  source: Source;
  /** What it asks to be allowed to do, shown before it is enabled. */
  permissions: string[];
  /** A logo the publisher supplies, a path inside the catalog repository with its SHA-256. */
  icon?: { file: string; sha256: string };
}

export interface Index {
  schema: typeof SCHEMA;
  /** Goes up with every publication. A device never accepts a lower number than one it has seen. */
  sequence: number;
  generatedAt: string;
  /** After this time the index is no longer accepted. */
  expires: string;
  entries: Entry[];
}

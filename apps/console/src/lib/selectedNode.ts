import { readJson, writeJson } from "./storage.ts";

/**
 * The node the console is managing in a cluster. null means the device you signed in to. Lives outside React so the
 * data layer can send it as the X-EPC-Node header on every host-level request.
 */
const KEY = "epc.node";
const listeners = new Set<() => void>();
let selected: string | null = readJson<string | null>(KEY, null);

export const getSelectedNode = (): string | null => selected;
export const subscribeSelectedNode = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
export function setSelectedNode(n: string | null): void {
  if (n === selected) return;
  selected = n;
  writeJson(KEY, n);
  listeners.forEach((l) => l());
}
/** Headers to merge into a request that works on a node. */
export const nodeHeaders = (): Record<string, string> => (selected ? { "X-EPC-Node": selected } : {});

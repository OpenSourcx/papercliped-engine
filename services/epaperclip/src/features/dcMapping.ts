import { checkDc, objectId, withDelete } from "./dcCommon.ts";
import { DC_SCHEMAS } from "./dcSchema.ts";
import { bad, confirmed, noExtra, seg, soft, type Deps, type Route } from "./nodeCommon.ts";
import type { Schema } from "./nodeSchema.ts";
import { parseProps } from "./nodeValidate.ts";

/**
 * Resource mappings: a cluster-wide name for a PCI device, USB device or shared directory, with the matching device
 * on each node. Machines point at the name, so they can move between nodes and keep their passthrough.
 */

type Raw = Record<string, any>;
const KINDS = {
  pci: { schema: DC_SCHEMAS.mappingPci, label: "PCI device" },
  usb: { schema: DC_SCHEMAS.mappingUsb, label: "USB device" },
  dir: { schema: DC_SCHEMAS.mappingDir, label: "directory" },
} as const;
type Kind = keyof typeof KINDS;
const kindOf = (s: string): Kind => (s in KINDS ? (s as Kind) : bad("Mappings are pci, usb or dir"));
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function describe(kind: Kind, raw: Raw) {
  const schema: Schema = KINDS[kind].schema;
  const item = schema.map.items!;
  const maps = (Array.isArray(raw.map) ? raw.map : []).map((m: unknown) => parseProps(m, item));
  return {
    id: String(raw.id ?? ""),
    description: typeof raw.description === "string" ? raw.description : "",
    mdev: raw.mdev === 1 || raw.mdev === true,
    liveMigration: raw["live-migration-capable"] === 1 || raw["live-migration-capable"] === true,
    digest: typeof raw.digest === "string" ? raw.digest : null,
    map: maps.map((p: Record<string, string>) => ({ node: p.node ?? "", path: p.path ?? "", id: p.id ?? "", subsystemId: p["subsystem-id"] ?? "", iommugroup: p.iommugroup === undefined ? null : Number(p.iommugroup), description: p.description ?? "" })),
    checks: (Array.isArray(raw.checks) ? raw.checks : []).slice(0, 50).map((c: Raw) => ({ severity: c.severity === "error" ? "error" : "warning", message: String(c.message ?? "").slice(0, 400) })),
  };
}

/** The structured rows from the browser become Proxmox's property strings (and are validated as such). */
function toValues(kind: Kind, body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.description !== undefined) out.description = body.description;
  if (kind === "pci") {
    if (body.mdev !== undefined) out.mdev = body.mdev;
    if (body.liveMigration !== undefined) out["live-migration-capable"] = body.liveMigration;
  }
  if (!Array.isArray(body.map) || body.map.length === 0 || body.map.length > 64) bad("Add at least one node and its device");
  const nodes = new Set<string>();
  out.map = body.map.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const item: Record<string, unknown> = { node: r.node, path: r.path, id: r.id };
    if (kind === "pci") {
      if (r.subsystemId) item["subsystem-id"] = r.subsystemId;
      if (typeof r.iommugroup === "number") item.iommugroup = r.iommugroup;
    }
    if (r.description) item.description = r.description;
    if (kind === "dir") delete item.id;
    if (typeof item.node === "string" && nodes.has(item.node) && kind !== "usb") bad(`${item.node} is listed twice; a PCI or directory mapping has one device per node`);
    if (typeof item.node === "string") nodes.add(item.node);
    return item;
  });
  return out;
}

export function mappingRoutes(_d: Deps): Route[] {
  return [
    {
      method: "GET",
      re: /^\/api\/node\/mappings$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = c.node;
          const [pci, usb, dir] = await Promise.all([soft(pve.call<Raw[]>("GET", "/cluster/mapping/pci", { "check-node": node })), soft(pve.call<Raw[]>("GET", "/cluster/mapping/usb")), soft(pve.call<Raw[]>("GET", "/cluster/mapping/dir"))]);
          return {
            pci: (pci.data ?? []).map((x) => describe("pci", x)),
            usb: (usb.data ?? []).map((x) => describe("usb", x)),
            dir: (dir.data ?? []).map((x) => describe("dir", x)),
            denied: pci.denied && usb.denied && dir.denied,
            checkedNode: node,
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/mappings\/(pci|usb|dir)$/,
      run: async (c, m) => {
        c.sameSite();
        const kind = kindOf(m[1]);
        const body = await c.readJson(100_000);
        noExtra(body, ["id", "description", "mdev", "liveMigration", "map"]);
        const id = objectId(body.id, "mapping name");
        const checked = checkDc(KINDS[kind].schema, toValues(kind, body), { creating: true });
        await c.asUser(async (pve) => {
          await verifyNodes(c, pve, checked.params.map as string[]);
          await pve.call("POST", `/cluster/mapping/${kind}`, { id, ...checked.params } as Record<string, string | number | string[]>);
        });
        c.json(201, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/mappings\/(pci|usb|dir)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const kind = kindOf(m[1]);
        const id = objectId(m[2], "mapping name");
        const body = await c.readJson(100_000);
        noExtra(body, ["description", "mdev", "liveMigration", "map", "digest"]);
        const checked = checkDc(KINDS[kind].schema, toValues(kind, body));
        const digest = typeof body.digest === "string" && /^[0-9a-f]{20,64}$/i.test(body.digest) ? body.digest : undefined;
        const clear = [body.description === "" ? "description" : null].filter((x): x is string => !!x);
        await c.asUser(async (pve) => {
          await verifyNodes(c, pve, checked.params.map as string[]);
          await pve.call("PUT", `/cluster/mapping/${kind}/${seg(id)}`, withDelete({ ...checked, remove: [...checked.remove, ...clear] }, { digest }));
        });
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/mappings\/(pci|usb|dir)\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const kind = kindOf(m[1]);
        if (!ID.test(m[2])) bad("That isn't a mapping");
        confirmed(await c.readJson(), m[2], `deleting the mapping ${m[2]}; machines that use it will no longer start`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/mapping/${kind}/${seg(m[2])}`));
        c.json(200, { ok: true });
      },
    },
  ];
}

/** Every node a mapping names has to exist in this cluster. */
async function verifyNodes(c: Parameters<Route["run"]>[0], pve: Parameters<Parameters<Parameters<Route["run"]>[0]["asUser"]>[0]>[0], map: string[]) {
  const known = await pve.call<{ node: string }[]>("GET", "/nodes");
  for (const entry of map) {
    const node = parseProps(entry).node;
    if (!known.some((n) => n.node === node)) throw new c.HttpError(404, "unknown_node", `This cluster has no node called ${node}`);
  }
}

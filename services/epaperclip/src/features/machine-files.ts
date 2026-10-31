import { createHash } from "node:crypto";
import type { ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { execInGuest } from "./guest-exec.ts";
import type { FeatureCtx, FeatureHandler } from "./index.ts";

/**
 * Files inside a machine, for PinView's file browser and its editor tiles. Everything runs through the same in-machine
 * command path Pin uses (guest-exec.ts): the QEMU guest agent for a VM, the independently authorizing local exec helper for a container, as the
 * signed-in person, so Proxmox's permissions decide (VM.GuestAgent.Unrestricted or VM.Monitor for a VM, VM.Console for a
 * container). Nothing is kept on the host.
 *
 *   GET  /api/guests/:vmid/files?path=/abs     the folder's entries (name, kind, size, modified), at most 2000
 *   GET  /api/guests/:vmid/file?path=/abs      a text file (up to 48 KiB, sent as base64 so nothing is mangled), its size and an etag
 *   PUT  /api/guests/:vmid/file                { path, content, etag? }: writes it; with an etag, refuses when the file changed since
 */

const ROUTE = /^\/api\/guests\/(\d{3,9})\/(files|file)$/;
export const MAX_EDIT = 48 * 1024;
const MAX_ENTRIES = 2000;
const TIMEOUT = 30_000;
/** Base64 characters per write chunk; bounds individual requests. */
const CHUNK = 2000;

const sq = (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`;
const etagOf = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 32);

/** An absolute path without NUL or line breaks, with `.` and `..` resolved, so the shell sees exactly what was asked. */
export function cleanPath(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith("/") || v.length > 1024 || /[\0\n\r]/.test(v)) return null;
  const out: string[] = [];
  for (const part of v.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export interface Entry { name: string; kind: "dir" | "file" | "link" | "linkdir"; size: number; mtime: number }

/** Parses the listing script's lines: kind, size, modified (epoch seconds) and the name, tab-separated. */
export function parseListing(out: string): Entry[] {
  const kinds: Record<string, Entry["kind"]> = { d: "dir", f: "file", l: "link", L: "linkdir" };
  const list: Entry[] = [];
  for (const line of out.split("\n")) {
    const m = /^([dflL])\t(\d+) (\d+)\t(.+)$/.exec(line);
    if (m && kinds[m[1]!]) list.push({ kind: kinds[m[1]!]!, size: Number(m[2]), mtime: Number(m[3]), name: m[4]! });
  }
  return list.sort((a, b) => (a.kind.endsWith("dir") === b.kind.endsWith("dir") ? a.name.localeCompare(b.name) : a.kind.endsWith("dir") ? -1 : 1));
}

const listScript = (path: string) => `cd -- ${sq(path)} 2>/dev/null || { echo "EPC_NODIR"; exit 3; }
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then if [ -d "$f" ]; then t=L; else t=l; fi; elif [ -d "$f" ]; then t=d; else t=f; fi
  m=$(stat -c '%s %Y' -- "$f" 2>/dev/null || echo '0 0')
  printf '%s\\t%s\\t%s\\n' "$t" "$m" "$f"
done | head -n ${MAX_ENTRIES + 1}`;

/** Size first, then (when small enough) the bytes as base64 between markers, so file contents round-trip without text transformations. */
const readScript = (path: string) => `[ -f ${sq(path)} ] || { echo "EPC_NOFILE"; exit 3; }
s=$(wc -c < ${sq(path)} | tr -d ' ')
echo "EPC_SIZE $s"
if [ "$s" -le ${MAX_EDIT} ]; then echo EPC_B64; base64 < ${sq(path)}; echo EPC_END; fi`;

function decode(out: string): { size: number; bytes: Buffer | null } {
  const size = Number(/EPC_SIZE (\d+)/.exec(out)?.[1] ?? NaN);
  if (!Number.isFinite(size)) throw new Error("The machine didn't say how big the file is.");
  const m = /EPC_B64\n([\s\S]*?)EPC_END/.exec(out);
  return { size, bytes: m ? Buffer.from(m[1]!.replace(/\s+/g, ""), "base64") : null };
}

export const handleMachineFiles: FeatureHandler = async (ctx: FeatureCtx) => {
  const m = ROUTE.exec(ctx.path);
  if (!m) return false;
  const { HttpError, method } = ctx;
  const vmid = Number(m[1]);
  const which = m[2];
  const s = ctx.session();
  if (s.apiToken) throw new HttpError(403, "ticket_only", "Machine files are opened in the console by a signed-in person.");

  const run = async (script: string) => (await runAll([script]))[0]!;
  /** Runs scripts one after another in the machine, as the signed-in person, and says whether it is a container. */
  const runAll = async (scripts: string[], onGuest?: (type: "lxc" | "qemu") => string[]) =>
    ctx.asUser(async (pve: ProxmoxClient) => {
      const g = (await pve.clusterResources()).find((r) => r.vmid === vmid && (r.type === "lxc" || r.type === "qemu"));
      if (!g) throw new HttpError(404, "not_found", `There is no machine ${vmid} that you can see.`);
      if (g.status !== "running") throw new HttpError(409, "not_running", `${g.name ?? vmid} isn't running. Start it first.`);
      const type = g.type as "lxc" | "qemu";
      const out = [];
      for (const script of onGuest ? onGuest(type) : scripts) {
        try {
          out.push(await execInGuest({ pve: async () => pve, connect: ctx.connect }, { type, vmid, node: g.node ?? ctx.node }, script, { timeoutMs: TIMEOUT }));
        } catch (e) {
          throw new HttpError(502, "machine_unreachable", e instanceof Error ? e.message : "Couldn't reach inside the machine.");
        }
      }
      return out;
    });

  if (which === "files") {
    if (method !== "GET") throw new HttpError(405, "method", "Method not allowed");
    const path = cleanPath(ctx.url.searchParams.get("path") ?? "/");
    if (!path) throw new HttpError(400, "bad_request", "Give an absolute path.");
    const r = await run(listScript(path));
    if (r.output.includes("EPC_NODIR")) throw new HttpError(404, "no_dir", `${path} isn't a folder you can open.`);
    const entries = parseListing(r.output);
    return ctx.json(200, { path, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES || r.truncated }), true;
  }

  if (method === "GET") {
    const path = cleanPath(ctx.url.searchParams.get("path"));
    if (!path || path === "/") throw new HttpError(400, "bad_request", "Give a file's absolute path.");
    const r = await run(readScript(path));
    if (r.output.includes("EPC_NOFILE")) throw new HttpError(404, "no_file", `${path} isn't a file you can open.`);
    const { size, bytes } = decode(r.output);
    if (!bytes) return ctx.json(200, { path, size, content: null, tooLarge: true, binary: false, etag: null }), true;
    const binary = bytes.includes(0);
    return ctx.json(200, { path, size, content: binary ? null : bytes.toString("utf8"), tooLarge: false, binary, etag: etagOf(bytes) }), true;
  }

  if (method !== "PUT") throw new HttpError(405, "method", "Method not allowed");
  ctx.sameSite();
  const body = await ctx.readJson(MAX_EDIT * 2 + 4096);
  const path = cleanPath(body.path);
  if (!path || path === "/") throw new HttpError(400, "bad_request", "Give a file's absolute path.");
  if (typeof body.content !== "string" || body.content.includes("\0")) throw new HttpError(400, "bad_request", "The content must be text.");
  const bytes = Buffer.from(body.content, "utf8");
  if (bytes.length > MAX_EDIT) throw new HttpError(413, "too_large", `Files up to ${MAX_EDIT / 1024} KiB can be edited here.`);
  if (body.etag !== undefined && body.etag !== null) {
    if (typeof body.etag !== "string") throw new HttpError(400, "bad_request", "etag must be text");
    const now = await run(readScript(path));
    if (!now.output.includes("EPC_NOFILE")) {
      const cur = decode(now.output);
      if (!cur.bytes || etagOf(cur.bytes) !== body.etag) throw new HttpError(409, "changed", "The file changed in the machine since you opened it. Reload it, then make your change again.");
    }
  }
  // Written through a temporary file next to it, then copied over the original so its owner and permissions stay. A
  // container's command goes through its terminal, whose input line can be as short as 4 KiB, so the content goes in chunks.
  const tmp = `${path}.epc-${Date.now().toString(36)}`;
  const b64 = bytes.toString("base64");
  const finish = `set -e\nbase64 -d < ${sq(`${tmp}.b64`)} > ${sq(tmp)}\nrm -f ${sq(`${tmp}.b64`)}\nif [ -f ${sq(path)} ]; then cat ${sq(tmp)} > ${sq(path)}; rm -f ${sq(tmp)}; else mv ${sq(tmp)} ${sq(path)}; fi\necho EPC_OK`;
  const outs = await runAll([], (type) => {
    const size = type === "lxc" ? CHUNK : b64.length || 1;
    const parts: string[] = [`set -e\n: > ${sq(`${tmp}.b64`)}\necho EPC_PART`];
    for (let i = 0; i < b64.length; i += size) parts.push(`set -e\nprintf '%s' ${sq(b64.slice(i, i + size))} >> ${sq(`${tmp}.b64`)}\necho EPC_PART`);
    return [...parts, finish];
  });
  const last = outs[outs.length - 1]!;
  if (outs.slice(0, -1).some((o) => !o.output.includes("EPC_PART")) || !last.output.includes("EPC_OK")) {
    const why = [...outs].reverse().find((o) => !/EPC_(OK|PART)/.test(o.output))?.output.trim().split("\n").slice(-1)[0];
    throw new HttpError(502, "write_failed", `The file wasn't written: ${why || "the machine gave no reason"}.`);
  }
  return ctx.json(200, { path, size: bytes.length, etag: etagOf(bytes) }), true;
};

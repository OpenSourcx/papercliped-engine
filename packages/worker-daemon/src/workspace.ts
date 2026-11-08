import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Workspaces live under one root and nowhere else. Every path from the host is checked here, whatever the host says. */

export class WorkspaceError extends Error {}

export function safePath(root: string, p: string): string {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new WorkspaceError("bad path");
  const abs = resolve(p);
  const r = resolve(root);
  if (abs === r || !abs.startsWith(r + sep)) throw new WorkspaceError("path is outside the workspace root");
  // The deepest existing ancestor must really be inside the root (a symlink cannot lead out of it).
  let probe = abs;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const realRoot = existsSync(r) ? realpathSync(r) : r;
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new WorkspaceError("path escapes the workspace root");
  return abs;
}

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<string>((ok, fail) => execFile(cmd, args, { cwd, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => (e ? fail(new WorkspaceError(`${cmd} ${args[0] ?? ""} failed: ${String(err || e.message).slice(0, 400)}`)) : ok(out))));

export async function ensureWorkspace(root: string, a: { path: string; mode?: "directory" | "worktree"; repo?: string; ref?: string }): Promise<string> {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const path = safePath(root, a.path);
  if (a.mode === "worktree" && a.repo) {
    if (existsSync(join(path, ".git"))) return path;
    const cache = join(resolve(root), ".repos", createHash("sha256").update(a.repo).digest("hex").slice(0, 16));
    mkdirSync(dirname(cache), { recursive: true });
    if (existsSync(cache)) await run("git", ["-C", cache, "fetch", "--all", "--prune", "--quiet"]).catch(() => {});
    else await run("git", ["clone", "--bare", "--quiet", a.repo, cache]);
    mkdirSync(dirname(path), { recursive: true });
    await run("git", ["-C", cache, "worktree", "add", "--detach", "--quiet", path, a.ref || "HEAD"]);
    return path;
  }
  mkdirSync(path, { recursive: true, mode: 0o755 });
  return path;
}

export async function removeWorkspace(root: string, p: string): Promise<void> {
  const path = safePath(root, p);
  // Never remove the root's direct children (organization folders) or the repo caches.
  const rel = path.slice(resolve(root).length + 1).split(sep);
  if (rel.length < 3 || rel[0] === ".repos") throw new WorkspaceError("refusing to remove that path");
  rmSync(path, { recursive: true, force: true });
  const repos = join(resolve(root), ".repos");
  if (existsSync(repos)) {
    const { readdirSync } = await import("node:fs");
    for (const d of readdirSync(repos)) await run("git", ["-C", join(repos, d), "worktree", "prune"]).catch(() => {});
  }
}

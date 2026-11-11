import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Platform differences the worker has to respect. Linux behaviour is unchanged; macOS gets per-user locations and its own tools. */

export interface Dirs { data: string; workspaces: string }

/**
 * Where the worker keeps its files when nothing overrides them (EPW_DIR, EPW_WORKSPACES). Linux keeps the system
 * service locations. A Mac has no /var/lib convention and a normal user cannot create /workspaces, so it uses the
 * person's own Library and home folders.
 */
export function defaultDirs(platform: NodeJS.Platform = process.platform, home: string = homedir()): Dirs {
  if (platform === "darwin") return { data: join(home, "Library", "Application Support", "epaperclip-worker"), workspaces: join(home, "epaperclip-workspaces") };
  return { data: "/var/lib/epaperclip-worker", workspaces: "/workspaces" };
}

export function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

export interface OllamaInstall {
  /** What to run or tell the person to do. */
  command: string;
  /** Whether the worker may run it itself when asked to (a Mac without Homebrew gets a download link instead). */
  automatic: boolean;
  needsRoot: boolean;
}

/** How to install Ollama here. The official install.sh is Linux only. */
export function ollamaInstall(platform: NodeJS.Platform = process.platform, brew = false): OllamaInstall {
  if (platform === "darwin") {
    return brew
      ? { command: "brew install ollama", automatic: true, needsRoot: false }
      : { command: "download Ollama for macOS from https://ollama.com/download/mac (or install Homebrew, then: brew install ollama)", automatic: false, needsRoot: false };
  }
  return { command: "curl -fsSL https://ollama.com/install.sh | sh", automatic: true, needsRoot: true };
}

/** Pids in `ps eww -ax -o pid=,command=` output whose environment carries `tag` (macOS has no /proc). */
export function pidsWithEnvTag(psOutput: string, tag: string, self: number = process.pid): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === self) continue;
    if (` ${m[2]} `.includes(` ${tag} `)) pids.push(pid);
  }
  return pids;
}

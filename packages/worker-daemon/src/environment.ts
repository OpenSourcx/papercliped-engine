import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Resolve tools as the service account, not as the person who installed the daemon. */
export function workerPath() {
  const home = process.env.HOME ?? "";
  return [dirname(process.execPath), home ? join(home, ".local", "bin") : "", ...(process.env.PATH ?? "").split(":")]
    .filter((d, i, a) => d && existsSync(d) && a.indexOf(d) === i).join(":");
}

export function inferenceEnvironment(port: number | null): Record<string, string> {
  if (port === null) return { PATH: workerPath() };
  const url = `http://127.0.0.1:${port}`;
  return { PATH: workerPath(), OLLAMA_HOST: url, OLLAMA_API_BASE: url, EPAPERCLIP_INFERENCE_URL: url, EPAPERCLIP_OPENAI_BASE_URL: `${url}/v1` };
}

export function commandEnvironment(base: Record<string, string>, task: Record<string, string>) {
  const env = { ...process.env, ...base, ...task };
  // These describe the worker's local inference lane. Cloud provider variables remain per-task.
  for (const k of ["OLLAMA_HOST", "OLLAMA_API_BASE", "EPAPERCLIP_INFERENCE_URL", "EPAPERCLIP_OPENAI_BASE_URL"]) {
    if (base[k]) env[k] = base[k];
  }
  return env;
}

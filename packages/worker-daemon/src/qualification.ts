import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codingProfile, workerLimits, type Capabilities, type CodingQualification } from "@papercliped-engine/worker-fabric";
import { inferenceEnvironment } from "./environment.ts";

export function readQualifications(dir: string): CodingQualification[] {
  try {
    const data = JSON.parse(readFileSync(join(dir, "qualifications.json"), "utf8"));
    return Array.isArray(data) ? data.filter((q) => q?.suite === "slug-v1" && typeof q.model === "string" && typeof q.passed === "boolean" && Number.isFinite(q.testedAt)) : [];
  } catch { return []; }
}

const TEST = `import unittest
from slug import slugify
class SlugTests(unittest.TestCase):
    def test_names(self):
        for text, expected in [("LunchVoice Hub", "lunchvoice-hub"), ("  Foo__BAR!!!  ", "foo-bar"), ("api", "api"), ("A---B", "a-b"), ("Room 101", "room-101")]:
            with self.subTest(text=text): self.assertEqual(slugify(text), expected)
    def test_empty(self):
        for text in ["", "   ", "!!!", "___"]:
            with self.subTest(text=text), self.assertRaises(ValueError): slugify(text)
`;

export interface CommandResult { ok: boolean; output: string }
export type QualificationExec = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<CommandResult>;
const exec: QualificationExec = (command, args, cwd, env) => new Promise((resolve) => {
  execFile(command, args, { cwd, env, timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (e, stdout, stderr) => resolve({ ok: !e, output: `${stdout}\n${stderr}${e ? `\n${e.message}` : ""}` }));
});

/** Deliberately one bounded attempt: never silently turn a greeting into coding readiness. */
export async function qualifyCoding(o: { dir: string; caps: Capabilities; model: string; gatePort: number; execute?: QualificationExec; fetchFn?: typeof fetch }) {
  const c = o.caps;
  const model = c.inference?.models.find((m) => m.name === o.model);
  const profile = codingProfile(o.model);
  if (!c.execution || !c.tools.aider || !c.tools.python) throw new Error("Install Aider and Python for the worker service account first.");
  if (!model?.digest || !profile) throw new Error("Choose an installed coding model with a known memory profile and digest.");
  if ((c.memory?.availableMb ?? 0) - workerLimits(c).reserveMemoryMb < profile.memoryMb) throw new Error("Not enough available physical memory to qualify this model. Unload other models or use a smaller model; swap is not model memory.");
  const maxContext = Math.min(c.inference?.maxContext ?? 4096, profile.maxContext);
  const env: NodeJS.ProcessEnv = { ...process.env, ...inferenceEnvironment(o.gatePort), PYTHONDONTWRITEBYTECODE: "1" };
  const base = env.OLLAMA_API_BASE!;
  // Must reach the running daemon's gate, never fall back to a raw listener.
  const health = await (o.fetchFn ?? fetch)(`${base}/epaperclip/health`, { signal: AbortSignal.timeout(3000) });
  const status = await health.json() as { gate?: boolean; maxContext?: number | null; running?: number; queued?: number };
  if (!health.ok || status.gate !== true || status.maxContext !== c.inference?.maxContext) throw new Error("The worker inference gate is unavailable or its context differs. Restart the worker service before qualifying.");
  if (status.running || status.queued) throw new Error("Drain the worker and wait for its inference queue to empty before qualifying.");
  const dir = mkdtempSync(join(tmpdir(), "epw-qualify-"));
  const run = o.execute ?? exec;
  let output = "";
  let passed = false;
  try {
    writeFileSync(join(dir, "slug.py"), 'def slugify(text):\n    raise NotImplementedError("Implement me")\n');
    writeFileSync(join(dir, "test_slug.py"), TEST);
    writeFileSync(join(dir, "models.yml"), `- name: ollama_chat/${o.model}\n  extra_params:\n    num_ctx: ${maxContext}\n    max_tokens: 1024\n`);
    const a = await run("aider", ["slug.py", "--read", "test_slug.py", "--model", `ollama_chat/${o.model}`, "--weak-model", `ollama_chat/${o.model}`, "--edit-format", "whole", "--model-settings-file", "models.yml", "--map-tokens", "0", "--no-git", "--no-auto-lint", "--no-auto-test", "--no-analytics", "--no-check-update", "--no-show-release-notes", "--yes-always", "--message", "Implement slugify in slug.py only. Lowercase, replace each run outside ASCII a-z and 0-9 with one hyphen, trim leading/trailing hyphens, and raise ValueError for an empty result. Use the Python standard library. Do not modify the tests."], dir, env);
    output = a.output;
    const intact = readFileSync(join(dir, "test_slug.py"), "utf8") === TEST;
    // Restore the authoritative test before running it even when the model changed it.
    writeFileSync(join(dir, "test_slug.py"), TEST);
    const t = await run("python3", ["-I", "-c", "import sys,unittest; sys.path.insert(0,'.'); r=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.discover('.', 'test_slug.py')); sys.exit(not r.wasSuccessful())"], dir, env);
    output += `\n${t.output}${intact ? "" : "\nFAIL: qualification tests were modified"}`;
    passed = a.ok && intact && t.ok;
  } catch (e) { output += `\n${(e as Error).message}`; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  const report: CodingQualification = { suite: "slug-v1", model: o.model, digest: model.digest, aiderVersion: c.tools.aider, executedAs: `${c.execution.uid}:${c.execution.user}`, maxContext, passed, testedAt: Date.now() };
  mkdirSync(o.dir, { recursive: true });
  const records = [...readQualifications(o.dir).filter((q) => q.model !== o.model), report];
  const target = join(o.dir, "qualifications.json");
  writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify(records, null, 2), { mode: 0o600 });
  renameSync(`${target}.${process.pid}.tmp`, target);
  writeFileSync(join(o.dir, "qualification-last.log"), output, { mode: 0o600 });
  return report;
}

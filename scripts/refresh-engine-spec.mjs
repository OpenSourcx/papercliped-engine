// Refreshes packages/engine-client/spec/openapi.json from a real engine of the pinned version.
//   node scripts/refresh-engine-spec.mjs <engine install dir> <engine url>
// The install dir is where `npm ci` put the engine (it holds node_modules/paperclipai); the url is a running instance of that
// same install (loopback, any auth mode: /api/openapi.json is public). The spec is written only when the install's version is
// the one pinned in engine/package.json, and spec/ENGINE_VERSION records it. packages/engine-client/test/spec-drift.test.ts then
// fails if the pin, the client's @paperclipai/shared, the plugin SDK and this snapshot ever disagree. See docs/UPGRADING.md.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, url] = process.argv.slice(2);
if (!dir || !url) { console.error("usage: node scripts/refresh-engine-spec.mjs <engine install dir> <engine url>"); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(readFileSync(join(root, "engine/package.json"), "utf8")).dependencies.paperclipai;
const installed = JSON.parse(readFileSync(join(dir, "node_modules/paperclipai/package.json"), "utf8")).version;
if (installed !== pinned) { console.error(`the install at ${dir} is paperclipai ${installed}, but engine/package.json pins ${pinned}`); process.exit(1); }
const res = await fetch(new URL("/api/openapi.json", url));
if (!res.ok) { console.error(`${url}/api/openapi.json answered ${res.status}`); process.exit(1); }
const text = await res.text();
const spec = JSON.parse(text);
if (!spec.openapi || !spec.paths || Object.keys(spec.paths).length < 100) { console.error("that does not look like Paperclip's OpenAPI document"); process.exit(1); }
writeFileSync(join(root, "packages/engine-client/spec/openapi.json"), text);
writeFileSync(join(root, "packages/engine-client/spec/ENGINE_VERSION"), `${pinned}\n`);
console.log(`spec for paperclipai ${pinned}: ${Object.keys(spec.paths).length} paths`);

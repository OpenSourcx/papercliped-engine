// Prints a catalog entry for an npm package, with the exact version and the registry's integrity hash filled in.
//   node scripts/marketplace-entry.mjs <package> <version> <id> "<name>" "<vendor>" "<summary>" [permission ...]
// Paste the output into marketplace/catalog.json (review it: the permissions are the publisher's declarations, shown to
// administrators before install; they are not enforced by this host). Use REGISTRY=<url> for a registry other than npmjs.
const [name, version, id, title, vendor, summary, ...permissions] = process.argv.slice(2);
if (!name || !/^\d+\.\d+\.\d+$/.test(version ?? "") || !id || !title || !vendor || !summary) { console.error('usage: node scripts/marketplace-entry.mjs <package> <exact version> <id> "<name>" "<vendor>" "<summary>" [permission ...]'); process.exit(2); }
const registry = process.env.REGISTRY ?? "https://registry.npmjs.org";
const r = await fetch(`${registry}/${name.replace("/", "%2F")}/${version}`, { headers: { Accept: "application/json" } });
if (!r.ok) { console.error(`The registry has no ${name}@${version} (${r.status}).`); process.exit(1); }
const integrity = (await r.json()).dist?.integrity;
if (!/^sha512-/.test(integrity ?? "")) { console.error("The registry gave no sha512 integrity for that version."); process.exit(1); }
console.log(JSON.stringify({ id, kind: "plugin", name: title, vendor, summary, version, source: { type: "npm", name, version, integrity }, permissions }, null, 2));

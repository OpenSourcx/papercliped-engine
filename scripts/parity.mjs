#!/usr/bin/env node
// Reads the parity matrix in docs/PARITY.md and prints counts by status, priority and workstream.
// Exits 1 if any P0 row is not "done". `--report` prints the same and always exits 0.
// Usage: node scripts/parity.mjs [--report] [--json] [path/to/PARITY.md]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STATUSES = ["done", "partial", "missing"];
export const PRIORITIES = ["P0", "P1", "P2", "-"];
export const WORKSTREAMS = ["W-NODE", "W-DISK", "W-MACHINE", "W-CLUSTER", "W-ACCESS", "W-ENGINE"];
const ID = /^[A-Z]{2,4}-\d{2,4}$/;

/** Rows of every table whose first cell is an ID like `ND-012`. Throws on a row with an unknown status, priority or workstream. */
export function parseParity(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.startsWith("|")) return;
    const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    if (!ID.test(cells[0])) return;
    if (cells.length < 8) throw new Error(`line ${i + 1}: ${cells[0]} has ${cells.length} columns, expected 9`);
    const [id, screen, item, api, status, pri, ws, evidence, seq] = cells;
    if (!STATUSES.includes(status)) throw new Error(`line ${i + 1}: ${id} has unknown status "${status}"`);
    if (!PRIORITIES.includes(pri)) throw new Error(`line ${i + 1}: ${id} has unknown priority "${pri}"`);
    if (!WORKSTREAMS.includes(ws)) throw new Error(`line ${i + 1}: ${id} has unknown workstream "${ws}"`);
    if (rows.some((r) => r.id === id)) throw new Error(`line ${i + 1}: duplicate ID ${id}`);
    rows.push({ id, screen, item, api, status, pri, ws, evidence, seq: seq ? Number(seq) : null });
  });
  return rows;
}

const tally = (rows, key, order) => Object.fromEntries(order.map((k) => [k, rows.filter((r) => r[key] === k).length]));

export function summarize(rows) {
  const p0Gaps = rows.filter((r) => r.pri === "P0" && r.status !== "done");
  return {
    total: rows.length,
    status: tally(rows, "status", STATUSES),
    priority: tally(rows, "pri", PRIORITIES),
    workstream: tally(rows, "ws", WORKSTREAMS),
    p0Gaps,
  };
}

function main(argv) {
  const report = argv.includes("--report");
  const json = argv.includes("--json");
  const file = argv.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../docs/PARITY.md", import.meta.url));
  const rows = parseParity(readFileSync(file, "utf8"));
  if (!rows.length) {
    console.error("parity: no rows found in " + file);
    return 2;
  }
  const s = summarize(rows);
  if (json) console.log(JSON.stringify(s, null, 2));
  else {
    const line = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join("  ");
    console.log(`Parity: ${s.total} rows`);
    console.log("  status:     " + line(s.status));
    console.log("  priority:   " + line(s.priority));
    console.log("  workstream: " + line(s.workstream));
    const p0 = rows.filter((r) => r.pri === "P0");
    console.log(`  P0 done:    ${p0.length - s.p0Gaps.length} of ${p0.length}`);
    for (const w of WORKSTREAMS) {
      const g = s.p0Gaps.filter((r) => r.ws === w);
      if (g.length) console.log(`\n${w}: ${g.length} P0 not done\n` + g.map((r) => `  ${r.id} [${r.status}] ${r.item}`).join("\n"));
    }
  }
  if (s.p0Gaps.length && !report) {
    console.error(`\nparity: ${s.p0Gaps.length} P0 item(s) not done`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

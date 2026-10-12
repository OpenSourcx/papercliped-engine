// Run with: node --test scripts/parity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseParity, summarize } from "./parity.mjs";

const head = "| ID | Screen | Item | API | Status | Pri | Workstream | Evidence | Seq |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
const doc = (...rows) => "# Title\n\nprose | with a pipe\n\n" + head + rows.join("\n") + "\n";

test("parses rows and ignores prose, headers and separators", () => {
  const rows = parseParity(doc("| ND-001 | Services | List | GET /nodes/{node}/services | missing | P0 | W-NODE | | 4 |", "| GU-002 | Power | Start | POST x | done | P0 | W-MACHINE | app.ts | |"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "ND-001", screen: "Services", item: "List", api: "GET /nodes/{node}/services", status: "missing", pri: "P0", ws: "W-NODE", evidence: "", seq: 4 });
  assert.equal(rows[1].seq, null);
});

test("rejects unknown values and duplicates", () => {
  assert.throws(() => parseParity(doc("| ND-001 | a | b | c | finished | P0 | W-NODE | | |")), /unknown status/);
  assert.throws(() => parseParity(doc("| ND-001 | a | b | c | done | P9 | W-NODE | | |")), /unknown priority/);
  assert.throws(() => parseParity(doc("| ND-001 | a | b | c | done | P0 | W-X | | |")), /unknown workstream/);
  assert.throws(() => parseParity(doc("| ND-001 | a | b | c | done | P0 | W-NODE | | |", "| ND-001 | a | b | c | done | P0 | W-NODE | | |")), /duplicate/);
  assert.throws(() => parseParity(doc("| ND-001 | a | b |")), /columns/);
});

test("summarize counts and lists P0 gaps only", () => {
  const s = summarize(parseParity(doc("| ND-001 | a | b | c | partial | P0 | W-NODE | | |", "| ND-002 | a | b | c | done | P0 | W-NODE | | |", "| DC-001 | a | b | c | missing | P1 | W-DISK | | |", "| BY-001 | a | b | c | done | - | W-ENGINE | | |")));
  assert.equal(s.total, 4);
  assert.equal(s.status.done, 2);
  assert.equal(s.priority["-"], 1);
  assert.deepEqual(s.p0Gaps.map((r) => r.id), ["ND-001"]);
});

test("the real matrix parses; --report never fails", () => {
  const rows = parseParity(readFileSync(new URL("../docs/PARITY.md", import.meta.url), "utf8"));
  assert.ok(rows.length > 200);
  const r = spawnSync(process.execPath, [new URL("./parity.mjs", import.meta.url).pathname, "--report"]);
  assert.equal(r.status, 0);
});

test("exits non-zero while a P0 is not done", () => {
  const r = spawnSync(process.execPath, [new URL("./parity.mjs", import.meta.url).pathname]);
  const gaps = summarize(parseParity(readFileSync(new URL("../docs/PARITY.md", import.meta.url), "utf8"))).p0Gaps.length;
  assert.equal(r.status, gaps ? 1 : 0);
});

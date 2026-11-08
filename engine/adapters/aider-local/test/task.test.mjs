import test from "node:test";
import assert from "node:assert/strict";
import { taskContract, taskMarkdown, escalationMarkdown, TaskContractError } from "../src/task.js";

const valid = { goal: "Fix label", allowedFiles: ["src/label.ts"], testCommand: "npm test -- label", definitionOfDone: "All label tests pass" };

test("task contract requires the four fields and specifically refuses no tests", () => {
  assert.deepEqual(taskContract({ taskContract: valid }, {}), { ...valid, maxAttempts: 3, escalationAdapter: null, escalationConfig: {} });
  assert.throws(() => taskContract({ taskContract: { ...valid, testCommand: "" } }, {}), (e) => e instanceof TaskContractError && e.code === "test_required");
  assert.throws(() => taskContract({ taskContract: { ...valid, allowedFiles: [] } }, {}), /allowed-files/);
  assert.throws(() => taskContract({ taskContract: { ...valid, allowedFiles: ["../secret"] } }, {}), /escape/);
});

test("run context overrides dedicated-agent config", () => {
  const got = taskContract({ taskContract: valid, maxAttempts: 2 }, { aiderTask: { ...valid, goal: "Context goal", maxAttempts: 4, escalationAdapter: "codex_local" } });
  assert.equal(got.goal, "Context goal");
  assert.equal(got.maxAttempts, 4);
  assert.equal(got.escalationAdapter, "codex_local");
});

test("task and escalation files carry the correctness oracle and handoff evidence", () => {
  const c = taskContract({ taskContract: valid }, {});
  assert.match(taskMarkdown(c, "FAIL expected device"), /FAIL expected device/);
  const handoff = escalationMarkdown(c, { model: "qwen2.5-coder:7b", attemptsUsed: 3, diff: "+bad", testLog: "FAIL" });
  assert.match(handoff, /Small-model diff/);
  assert.match(handoff, /npm test -- label/);
});

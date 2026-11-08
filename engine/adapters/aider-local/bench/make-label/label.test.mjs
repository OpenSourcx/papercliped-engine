import test from "node:test";
import assert from "node:assert/strict";
import { makeLabel } from "./label.ts";

test("normalizes case and runs of punctuation", () => {
  assert.equal(makeLabel("  Hello___WORLD...Again  "), "hello-world-again");
  assert.equal(makeLabel("--Device--"), "device");
});

test("empty normalized input becomes device", () => {
  assert.equal(makeLabel(""), "device");
  assert.equal(makeLabel("!!!___---"), "device");
});

test("only exact reserved names throw", () => {
  for (const value of ["api", "www", "auth", "API", "---AUTH---"]) {
    assert.throws(() => makeLabel(value), /reserved|not allowed|invalid/i);
  }
  assert.equal(makeLabel("rapid"), "rapid");
  assert.equal(makeLabel("therapist"), "therapist");
  assert.equal(makeLabel("auth-service"), "auth-service");
});

test("cuts at 40 characters and never leaves a trailing dash", () => {
  assert.equal(makeLabel("a".repeat(39) + "---Z"), "a".repeat(39));
  assert.equal(makeLabel("A".repeat(41)), "a".repeat(40));
});

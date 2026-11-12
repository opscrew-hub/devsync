import assert from "node:assert/strict";
import { test } from "node:test";
import { transitions } from "./lifecycle.ts";
test("tasks must pass review before completion", () => {
  assert.deepEqual(Object.keys(transitions).filter(status => transitions[status as keyof typeof transitions].includes("DONE")), ["REVIEW"]);
});
test("finished tasks are terminal", () => {
  assert.deepEqual(transitions.DONE, []);
  assert.deepEqual(transitions.CANCELLED, []);
});

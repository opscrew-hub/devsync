import { describe, expect, it } from "vitest";
import { Action, can } from "./permissions";
import { Role } from "./roles";

describe("can()", () => {
  it("follows docs/host.md's table", () => {
    const table = Object.fromEntries(
      Role.options.map((role) => [
        role,
        Object.fromEntries(Action.options.map((action) => [action, can(role, action)])),
      ]),
    );
    expect(table).toEqual({
      owner: { "task.write": true, "agent.manage": true, "run.request": true, "run.decide": true },
      admin: { "task.write": true, "agent.manage": true, "run.request": true, "run.decide": true },
      approver: {
        "task.write": true,
        "agent.manage": false,
        "run.request": true,
        "run.decide": true,
      },
      developer: {
        "task.write": true,
        "agent.manage": false,
        "run.request": true,
        "run.decide": false,
      },
    });
  });
});

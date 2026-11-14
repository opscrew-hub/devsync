import { z } from "zod";
import type { Role } from "./roles";

/** What a member may be refused (docs/host.md, Roles and permissions). Reads need no action. */
export const Action = z.enum(["task.write", "agent.manage", "run.request", "run.decide"]);
export type Action = z.infer<typeof Action>;

const ALLOWED: Record<Action, readonly Role[]> = {
  "task.write": ["owner", "admin", "approver", "developer"],
  "agent.manage": ["owner", "admin"],
  "run.request": ["owner", "admin", "approver", "developer"],
  "run.decide": ["owner", "admin", "approver"],
};

/** Whether a member with `role` may do `action`: on the server, and to lock buttons in the browser. */
export function can(role: Role, action: Action): boolean {
  return ALLOWED[action].includes(role);
}

import type { statuses } from "@devsync/contracts";
type Status = (typeof statuses)[number];
export const transitions: Record<Status, readonly Status[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "IN_PROGRESS", "CANCELLED"],
  CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "REVIEW", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
  REVIEW: ["READY", "IN_PROGRESS", "DONE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

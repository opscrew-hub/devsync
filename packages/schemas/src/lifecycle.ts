import { z } from "zod";

/** A task's statuses: legacy's names. */
export const TaskStatus = z.enum([
  "BACKLOG",
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** The statuses' plain-English names, for the pages. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: "Backlog",
  READY: "Ready",
  CLAIMED: "Claimed",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  REVIEW: "Review",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** The moves allowed from each status. Done and Cancelled are final. */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["BACKLOG", "IN_PROGRESS", "CANCELLED"],
  CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "REVIEW", "CANCELLED"],
  BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
  REVIEW: ["READY", "IN_PROGRESS", "DONE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

import { describe, expect, it } from "vitest";
import { STATUS_LABEL, TaskStatus, TRANSITIONS } from "./lifecycle";

describe("the task lifecycle", () => {
  it("has the statuses, in order", () => {
    expect(TaskStatus.options).toEqual([
      "BACKLOG",
      "READY",
      "CLAIMED",
      "IN_PROGRESS",
      "BLOCKED",
      "REVIEW",
      "DONE",
      "CANCELLED",
    ]);
  });

  it("allows the lifecycle's moves only", () => {
    expect(TRANSITIONS).toEqual({
      BACKLOG: ["READY", "CANCELLED"],
      READY: ["BACKLOG", "IN_PROGRESS", "CANCELLED"],
      CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
      IN_PROGRESS: ["BLOCKED", "REVIEW", "CANCELLED"],
      BLOCKED: ["READY", "IN_PROGRESS", "CANCELLED"],
      REVIEW: ["READY", "IN_PROGRESS", "DONE", "CANCELLED"],
      DONE: [],
      CANCELLED: [],
    });
  });

  it("ends at Done and Cancelled, and every open status can be cancelled", () => {
    for (const status of TaskStatus.options) {
      const final = status === "DONE" || status === "CANCELLED";
      expect(TRANSITIONS[status].includes("CANCELLED")).toBe(!final);
      expect(TRANSITIONS[status].length === 0).toBe(final);
    }
  });

  it("names each status in plain English", () => {
    expect(Object.values(STATUS_LABEL)).toEqual([
      "Backlog",
      "Ready",
      "Claimed",
      "In progress",
      "Blocked",
      "Review",
      "Done",
      "Cancelled",
    ]);
  });
});

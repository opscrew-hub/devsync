import { describe, expect, it } from "vitest";
import * as server from "./index";

describe("@devsync/server", () => {
  it("exports what its host needs and nothing of the domain's internals", () => {
    expect(Object.keys(server).sort()).toEqual([
      "DevSyncError",
      "ERROR_STATUS",
      "agent",
      "githubDelivery",
      "jobs",
      "migrations",
      "outboxEvent",
      "projectRoutes",
      "publicRoutes",
      "pullRequest",
      "removeMember",
      "removeProject",
      "removeWorkspace",
      "run",
      "signal",
      "task",
      "taskComment",
      "taskRevision",
      "workspaceRoutes",
    ]);
  });
});

import {
  AgentList,
  MemberList,
  PullRequestList,
  TaskDetail,
  TaskList,
  type TaskStatus,
  WorkspaceTaskList,
} from "@devsync/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { DevSyncRequestError } from "./client";
import { useDevSync } from "./provider";

/** Every 10 seconds while the page is visible (the dashboard refreshes by polling). */
const LIVE = { refetchInterval: 10_000, refetchIntervalInBackground: false } as const;

/** Keys are namespaced by the mount point, so a project's data never shows on another's tab. */
function useList<T>(
  path: string,
  parse: (api: ReturnType<typeof useDevSync>["api"]) => Promise<T>,
) {
  const { api, apiBase } = useDevSync();
  return useQuery({ queryKey: ["devsync", apiBase, path], queryFn: () => parse(api), ...LIVE });
}

export const useTasks = () => useList("/tasks", (api) => api.get("/tasks", TaskList));
export const useMembers = () => useList("/members", (api) => api.get("/members", MemberList));
export const useAgents = () => useList("/agents", (api) => api.get("/agents", AgentList));
export const usePullRequests = () =>
  useList("/pull-requests", (api) => api.get("/pull-requests", PullRequestList));

export function useTask(taskId: string) {
  const path = `/tasks/${encodeURIComponent(taskId)}`;
  return useList(path, (api) => api.get(path, TaskDetail));
}

/** The workspace's tasks; without `status`, the open ones. */
export function useWorkspaceTasks(filters: {
  project?: string;
  status?: TaskStatus;
  mine?: boolean;
}) {
  const query = new URLSearchParams();
  if (filters.project) query.set("project", filters.project);
  if (filters.status) query.set("status", filters.status);
  if (filters.mine) query.set("assignee", "me");
  const path = query.size > 0 ? `/tasks?${query}` : "/tasks";
  return useList(path, (api) => api.get(path, WorkspaceTaskList));
}

const INVALID = "Fill in the required fields and keep each within its limit, then try again.";

/**
 * A change through the API: what the page sends is parsed with `schema` first (a failure is the
 * mutation's error, in plain English); then everything under the mount point is read again.
 */
export function useChange<S extends z.ZodType, R>(
  schema: S,
  change: (api: ReturnType<typeof useDevSync>["api"], input: z.infer<S>) => Promise<R>,
) {
  const { api, apiBase } = useDevSync();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new DevSyncRequestError("invalid", INVALID, 0);
      return change(api, parsed.data);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["devsync", apiBase] }),
  });
}

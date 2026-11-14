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

/** A change through the API; then everything under the mount point is read again. */
export function useChange<V, R>(
  change: (api: ReturnType<typeof useDevSync>["api"], vars: V) => Promise<R>,
) {
  const { api, apiBase } = useDevSync();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => change(api, vars),
    onSettled: () => client.invalidateQueries({ queryKey: ["devsync", apiBase] }),
  });
}

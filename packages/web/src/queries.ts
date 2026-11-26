import {
  AgentList,
  FindingAnswer,
  MemberList,
  PullRequestList,
  RunList,
  RunSetup,
  type Task,
  TaskDetail,
  TaskList,
  type TaskStatus,
  WorkspaceTaskList,
} from "@devsync/schemas";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { DevSyncRequestError } from "./client";
import { useDevSync } from "./provider";

/** Every 10 seconds while the page is visible (the dashboard refreshes by polling). */
const LIVE = { refetchInterval: 10_000, refetchIntervalInBackground: false } as const;

/**
 * `GET path`, parsed with `schema`, refreshed while the page is visible. Keys are namespaced by the
 * mount point, so a project's data never shows on another's tab.
 */
function useLive<S extends z.ZodType>(path: string, schema: S) {
  const { api, apiBase } = useDevSync();
  return useQuery({
    queryKey: ["devsync", apiBase, path],
    queryFn: () => api.get(path, schema),
    ...LIVE,
  });
}

/**
 * A list of tasks page by page: `GET path`, then with each page's `nextCursor` as `cursor` when
 * the page asks for more (`fetchNextPage`; `hasNextPage` says there is more), every page read so
 * far refreshed while the page is visible. `tasks` is them all, each task once.
 */
function useTaskPages<T extends Task>(
  path: string,
  schema: z.ZodType<{ tasks: T[]; nextCursor: string | null }>,
) {
  const { api, apiBase } = useDevSync();
  const query = useInfiniteQuery({
    queryKey: ["devsync", apiBase, path],
    queryFn: ({ pageParam }) => {
      const cursor = pageParam && new URLSearchParams({ cursor: pageParam });
      return api.get(cursor ? `${path}${path.includes("?") ? "&" : "?"}${cursor}` : path, schema);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    ...LIVE,
  });
  const tasks = new Map<string, T>();
  for (const page of query.data?.pages ?? []) {
    for (const task of page.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
  }
  return { ...query, tasks: [...tasks.values()] };
}

/** The project's tasks, most recently updated first, 100 a page. */
export const useTasks = () => useTaskPages("/tasks", TaskList);
export const useMembers = () => useLive("/members", MemberList);
export const useAgents = () => useLive("/agents", AgentList);
export const usePullRequests = () => useLive("/pull-requests", PullRequestList);

export const useTask = (taskId: string) =>
  useLive(`/tasks/${encodeURIComponent(taskId)}`, TaskDetail);

/** A task's runs, newest first (they cost no GitHub call, so they refresh with the panel). */
export const useRuns = (taskId: string) =>
  useLive(`/tasks/${encodeURIComponent(taskId)}/runs`, RunList);

/**
 * What the repository has of what a run needs. Asking costs several GitHub calls, so it is read
 * the first time a runs section opens and when the member asks again, and kept while the tab is in
 * use: never on a timer, on focus, on opening another task or after a change (its key is outside
 * the `["devsync"]` that changes read again).
 */
export function useRunSetup() {
  const { api, apiBase } = useDevSync();
  return useQuery({
    queryKey: ["devsync-setup", apiBase],
    queryFn: () => api.get("/runs/setup", RunSetup),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
}

/**
 * A security finding and the task linked to it, by its fingerprint in the query string (it may
 * hold a `/`). Read afresh each time the tab arrives with it (nothing is kept once the tab leaves
 * it, so a task made since opens), never on a timer, and a resolved finding's 404 is an answer, not
 * a failure to retry. Its key is outside `["devsync"]`, so creating the task doesn't read
 * it again.
 */
export function useFinding(fingerprint: string) {
  const { api, apiBase } = useDevSync();
  return useQuery({
    queryKey: ["devsync-finding", apiBase, fingerprint],
    queryFn: () => api.get(`/findings?${new URLSearchParams({ fingerprint })}`, FindingAnswer),
    gcTime: 0,
    refetchInterval: false,
    retry: false,
  });
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
  return useTaskPages(query.size > 0 ? `/tasks?${query}` : "/tasks", WorkspaceTaskList);
}

const INVALID = "Fill in the required fields and keep each within its limit, then try again.";

/**
 * A change through the API: what the page sends is parsed with `schema` first (a failure is the
 * mutation's error, in plain English); then every DevSync list and task is stale, under every
 * mount point: a task changed on its project's tab is read again on the workspace page too, which
 * the host would otherwise keep showing as it was while its answers count as fresh. The lists on
 * screen are read at once, the others when they open again.
 */
export function useChange<S extends z.ZodType, R>(
  schema: S,
  change: (api: ReturnType<typeof useDevSync>["api"], input: z.infer<S>) => Promise<R>,
) {
  const { api } = useDevSync();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new DevSyncRequestError("invalid", INVALID, 0);
      return change(api, parsed.data);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["devsync"] }),
  });
}

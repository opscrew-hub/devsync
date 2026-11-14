/**
 * DevSync's web entry, named by the `opscrewModule` manifest in the root package.json: the host's
 * generated registry loads it lazily and renders `webModule`'s pages with the contract's props (the
 * host's contract, "What a module exports (webModule)"). The types are DevSync's copy of the
 * contract's; each page wraps DevSync's own in `DevSyncProvider`.
 */
import type { Role } from "@devsync/schemas";
import { type ComponentType, type FormEvent, type ReactNode, useMemo } from "react";
import { ProjectTab } from "./ProjectTab";
import { DevSyncProvider, type DevSyncUi } from "./provider";
import { WorkspacePage } from "./WorkspacePage";

/** The host's UI pieces: any icon name of the dashboard's sprite, which has every `DevSyncIcon`. */
export interface ModuleUi {
  Icon: ComponentType<{ name: string; className?: string }>;
  Dialog: ComponentType<{
    title: string;
    icon: string;
    onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
    children: ReactNode;
  }>;
  EmptyState: ComponentType<{
    icon: string;
    title: string;
    children: ReactNode;
    action?: ReactNode;
  }>;
  Link: ComponentType<{ to: string; className?: string; children: ReactNode }>;
}

interface ModulePageProps {
  /** `/api/w/<ws>/projects/<pid>/m/devsync` or `/api/w/<ws>/m/devsync`. */
  apiBase: string;
  userId: string;
  role: Role;
  ui: ModuleUi;
}

export interface ModuleProjectTabProps extends ModulePageProps {
  project: { id: string; fullName: string; readOnly: boolean };
  /** The page's search parameters, and a setter that replaces them (no new history entry). */
  query: URLSearchParams;
  setQuery(next: Record<string, string | null>): void;
}

export interface ModuleWorkspacePageProps extends ModulePageProps {
  /** The address of a project's DevSync tab, with `query` in its search. */
  projectHref(projectId: string, query?: Record<string, string>): string;
}

export interface WebModule {
  ProjectTab: ComponentType<ModuleProjectTabProps>;
  WorkspacePage?: ComponentType<ModuleWorkspacePageProps>;
}

/**
 * The host's pieces as DevSync's. Each takes any icon name, so every `DevSyncIcon` DevSync passes;
 * TypeScript still refuses the assignment because a component class's `defaultProps` would read
 * the wider props back, which DevSync never does. Listing each piece keeps a new `DevSyncUi` piece
 * a type error here.
 */
function devSyncUi({ Icon, Dialog, EmptyState, Link }: ModuleUi): DevSyncUi {
  return {
    Icon: Icon as DevSyncUi["Icon"],
    Dialog: Dialog as DevSyncUi["Dialog"],
    EmptyState: EmptyState as DevSyncUi["EmptyState"],
    Link,
  };
}

/** DevSync's provider for the member the host names, under `apiBase`. */
function Provider({
  apiBase,
  userId,
  role,
  ui,
  children,
}: ModulePageProps & { children: ReactNode }) {
  const pieces = useMemo(() => devSyncUi(ui), [ui]);
  return (
    <DevSyncProvider apiBase={apiBase} userId={userId} role={role} ui={pieces}>
      {children}
    </DevSyncProvider>
  );
}

/** A project's DevSync tab; the open task is the query's `?task=`. */
function ModuleProjectTab({ query, setQuery, ...page }: ModuleProjectTabProps) {
  return (
    <Provider {...page}>
      <ProjectTab selectedTaskId={query.get("task")} onSelectTask={(task) => setQuery({ task })} />
    </Provider>
  );
}

/** The workspace's DevSync page; a task links to its project's tab with the task open. */
function ModuleWorkspacePage({ projectHref, ...page }: ModuleWorkspacePageProps) {
  return (
    <Provider {...page}>
      <WorkspacePage taskHref={(projectId, task) => projectHref(projectId, { task })} />
    </Provider>
  );
}

export const webModule = {
  ProjectTab: ModuleProjectTab,
  WorkspacePage: ModuleWorkspacePage,
} satisfies WebModule;

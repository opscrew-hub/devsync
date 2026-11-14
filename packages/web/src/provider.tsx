import { type Action, can, type Role } from "@devsync/schemas";
import {
  type ComponentType,
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { createClient, type DevSyncClient, type FetchLike } from "./client";

/** The icons DevSync names: the host's sprite has each (docs/host.md, Pages). */
export type DevSyncIcon =
  | "kanban"
  | "plus"
  | "robot"
  | "git-pull-request"
  | "copy"
  | "trash"
  | "paper-plane-tilt"
  | "arrows-clockwise"
  | "clock-counter-clockwise"
  | "chat-circle-text"
  | "check-circle"
  | "warning";

export interface DevSyncIconProps {
  name: DevSyncIcon;
  className?: string;
}

export interface DevSyncDialogProps {
  title: string;
  icon: DevSyncIcon;
  /** With it, the dialog is a form. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}

export interface DevSyncEmptyStateProps {
  icon: DevSyncIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

export interface DevSyncLinkProps {
  /** A path in the host's router. */
  to: string;
  className?: string;
  children: ReactNode;
}

/** The host's UI pieces, so DevSync looks like the rest of the dashboard. */
export interface DevSyncUi {
  Icon: ComponentType<DevSyncIconProps>;
  Dialog: ComponentType<DevSyncDialogProps>;
  EmptyState: ComponentType<DevSyncEmptyStateProps>;
  Link: ComponentType<DevSyncLinkProps>;
}

export interface DevSyncProviderProps {
  /** Where DevSync's routes are mounted: the project's or the workspace's (docs/host.md). */
  apiBase: string;
  /** The signed-in member's user id and role in the workspace. */
  userId: string;
  role: Role;
  /** A read-only or disconnected project: the host refuses every change, so every action is locked. */
  readOnly?: boolean;
  ui: DevSyncUi;
  /** Tests pass a fake; the dashboard leaves it out. */
  fetch?: FetchLike;
  children: ReactNode;
}

interface DevSyncContext {
  api: DevSyncClient;
  apiBase: string;
  userId: string;
  role: Role;
  /** A read-only or disconnected project, where every change is refused. */
  readOnly: boolean;
  ui: DevSyncUi;
  /** Whether the member may do `action` on this project: locks the buttons the server would refuse. */
  may: (action: Action) => boolean;
}

const Context = createContext<DevSyncContext | null>(null);

/** Gives DevSync's pages their API, the member and the host's UI. Inside the host's QueryClientProvider. */
export function DevSyncProvider({
  apiBase,
  userId,
  role,
  readOnly = false,
  ui,
  fetch,
  children,
}: DevSyncProviderProps) {
  const value = useMemo<DevSyncContext>(
    () => ({
      api: createClient(apiBase, fetch ?? ((input, init) => globalThis.fetch(input, init))),
      apiBase,
      userId,
      role,
      readOnly,
      ui,
      may: (action) => !readOnly && can(role, action),
    }),
    [apiBase, userId, role, readOnly, ui, fetch],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDevSync(): DevSyncContext {
  const context = useContext(Context);
  if (!context) throw new Error("DevSync's pages must be rendered inside DevSyncProvider.");
  return context;
}

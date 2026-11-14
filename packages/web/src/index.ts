/**
 * DevSync's pages for the host dashboard: `webModule`, the entry the host loads (module.tsx), and
 * DevSyncProvider, ProjectTab and WorkspacePage, which it wraps.
 */

export { DevSyncRequestError, type ErrorCode, type FetchLike } from "./client";
export {
  type ModuleProjectTabProps,
  type ModuleUi,
  type ModuleWorkspacePageProps,
  type WebModule,
  webModule,
} from "./module";
export { ProjectTab, type ProjectTabProps } from "./ProjectTab";
export {
  type DevSyncDialogProps,
  type DevSyncEmptyStateProps,
  type DevSyncIcon,
  type DevSyncIconProps,
  type DevSyncLinkProps,
  DevSyncProvider,
  type DevSyncProviderProps,
  type DevSyncUi,
} from "./provider";
export { WorkspacePage, type WorkspacePageProps } from "./WorkspacePage";

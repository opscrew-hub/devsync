/**
 * DevSync's routes for its host to mount (docs/host.md, Mount points), each a Hono app with its own
 * `onError`: a project's, a workspace's, and the public MCP endpoint. Their environments
 * (`ProjectEnv`, `WorkspaceEnv`) are in host.ts.
 */
export { publicRoutes } from "./mcp";
export { projectRoutes } from "./project";
export { workspaceRoutes } from "./workspace";

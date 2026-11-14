import { z } from "zod";

/** The host workspace's roles: OpsCrew's four. DevSync's permissions map them (docs/host.md). */
export const Role = z.enum(["owner", "admin", "approver", "developer"]);
export type Role = z.infer<typeof Role>;

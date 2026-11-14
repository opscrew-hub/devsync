import { z } from "zod";
import { Id } from "./common";
import { Role } from "./roles";

/** A member of the host's workspace, with their role there. */
export const Member = z.object({ userId: Id, name: z.string(), role: Role });
export type Member = z.infer<typeof Member>;

/** `GET /members` (project and workspace routes). */
export const MemberList = z.object({ members: z.array(Member) });
export type MemberList = z.infer<typeof MemberList>;

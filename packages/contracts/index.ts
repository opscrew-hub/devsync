import { z } from "zod";
export const projectInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
});
export const taskInput = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(8000),
  acceptanceCriteria: z.string().trim().max(8000),
});
export const statuses = ["BACKLOG", "READY", "CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE", "CANCELLED"] as const;
export const taskUpdate = taskInput.partial().extend({
  version: z.number().int().positive(),
  status: z.enum(statuses).optional(),
});

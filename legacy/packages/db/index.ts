import { PrismaClient } from "./generated/client/client.ts";
const globalDb = globalThis as typeof globalThis & { devsyncDb?: PrismaClient };
export const db = globalDb.devsyncDb ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalDb.devsyncDb = db;

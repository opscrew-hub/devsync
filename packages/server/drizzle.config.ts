import { defineConfig } from "drizzle-kit";

/** `drizzle-kit generate` writes the next SQL migration from `src/db/schema.ts` into `migrations/`. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  schemaFilter: ["devsync"],
});

import { defineConfig } from "vitest/config";

// PGlite starts and runs the migration in every test file's setup hook; on a loaded CI runner that
// takes well over Vitest's default 10 s.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });

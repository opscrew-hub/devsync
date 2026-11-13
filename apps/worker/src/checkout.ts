import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function withCheckout<T>(
  repository: string,
  commit: string,
  signal: AbortSignal,
  use: (directory: string) => Promise<T>,
) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full commit SHA is required.");
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "devsync-checkout-"));
  const git = (...args: string[]) => exec("git", ["-c", "core.hooksPath=" + join(directory, ".disabled-hooks"), ...args], {
    cwd: directory,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  try {
    await git("clone", "--no-local", "--no-checkout", "--", repository, ".");
    await git("checkout", "--detach", commit);
    signal.throwIfAborted();
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

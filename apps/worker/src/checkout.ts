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
  cloneToken?: string,
) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full commit SHA is required.");
  if (cloneToken && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(repository)) {
    throw new Error("Authenticated checkout requires a GitHub HTTPS repository URL.");
  }
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "devsync-checkout-"));
  const git = (...args: string[]) => exec("git", ["-c", "core.hooksPath=" + join(directory, ".disabled-hooks"), ...args], {
    cwd: directory,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  try {
    if (cloneToken) {
      try {
        await exec("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false",
          "clone", "--no-checkout", "--", repository, "."], {
          cwd: directory, signal,
          env: {
            ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from("x-access-token:" + cloneToken).toString("base64"),
          },
        });
      } catch {
        signal.throwIfAborted();
        throw new Error("Authenticated GitHub clone failed.");
      }
    } else {
      await git("clone", "--no-local", "--no-checkout", "--", repository, ".");
    }
    await git("checkout", "--detach", commit);
    signal.throwIfAborted();
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

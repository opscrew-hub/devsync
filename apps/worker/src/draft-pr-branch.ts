import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { withCheckout } from "./checkout.ts";
import type { DraftPlan } from "./draft-pr-plan.ts";

const exec = promisify(execFile);

export async function ensureDraftBranch(
  repository: string, plan: DraftPlan, signal: AbortSignal, token?: string,
) {
  if (!/^devsync\/run-[a-f0-9]{64}$/.test(plan.head)) throw new Error("Invalid managed branch.");
  const ref = `refs/heads/${plan.head}`;
  await withCheckout(repository, plan.baseCommit, signal, async directory => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const git = (...args: string[]) => exec("git", args, { cwd: directory, signal, env });
    const patchFile = join(directory, ".git", "devsync.patch");
    await writeFile(patchFile, plan.patch, { flag: "wx" });
    await git("apply", "--cached", "--binary", "--", patchFile);
    const tree = (await git("write-tree")).stdout.trim();
    const date = (await git("show", "-s", "--format=%cI", plan.baseCommit)).stdout.trim();
    const { stdout } = await exec("git", ["commit-tree", tree, "-p", plan.baseCommit, "-m", "DevSync managed run"], {
      cwd: directory, signal,
      env: {
        ...env, GIT_AUTHOR_NAME: "DevSync", GIT_AUTHOR_EMAIL: "devsync@users.noreply.github.com",
        GIT_COMMITTER_NAME: "DevSync", GIT_COMMITTER_EMAIL: "devsync@users.noreply.github.com",
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      },
    });
    const commit = stdout.trim();
    async function remote(...args: string[]) {
      try {
        return await exec("git", [
          "-c", "core.hooksPath=" + join(directory, ".disabled-hooks"),
          "-c", "credential.helper=", "-c", "http.followRedirects=false", ...args,
        ], {
          cwd: directory, signal,
          env: token ? {
            ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64"),
          } : env,
        });
      } catch {
        signal.throwIfAborted();
        throw new Error("Managed branch Git operation failed.");
      }
    }
    async function remoteCommit() {
      return (await remote("ls-remote", "--refs", "origin", ref)).stdout.trim().split("\t")[0];
    }
    const existing = await remoteCommit();
    if (existing === commit) return;
    if (existing) throw new Error("Managed branch already points to a different commit.");
    try {
      await remote("push", `--force-with-lease=${ref}:`, "origin", `${commit}:${ref}`);
    } catch (error) {
      if (await remoteCommit() !== commit) throw error;
    }
  }, token);
}

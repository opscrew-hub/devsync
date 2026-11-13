import { createHash } from "node:crypto";

export function planDraftPullRequest(
  run: { id: string; revision: number; title: string },
  result: { baseCommit?: string | null; patch?: string | null },
) {
  const { baseCommit, patch } = result;
  if (!patch) return null;
  if (!baseCommit || !/^[a-f0-9]{40}$/.test(baseCommit)) {
    throw new Error("Draft pull request requires a pinned base commit.");
  }
  const branchKey = createHash("sha256").update(run.id).digest("hex");
  return {
    head: `devsync/run-${branchKey}`,
    baseCommit,
    patch,
    title: `DevSync: ${run.title.replace(/\s+/g, " ").trim()}`.slice(0, 240),
    body: `Managed run: ${run.id}\nTask revision: ${run.revision}\nBase commit: ${baseCommit}`,
    draft: true as const,
  };
}

type DraftPlan = NonNullable<ReturnType<typeof planDraftPullRequest>>;
type DraftPull = { number: number; url: string };

export async function publishDraftPullRequest(
  plan: DraftPlan,
  base: string,
  github: {
    findPull(head: string, base: string): Promise<DraftPull | null>;
    ensureBranch(plan: DraftPlan): Promise<void>;
    createPull(input: Omit<DraftPlan, "baseCommit" | "patch"> & { base: string }): Promise<DraftPull>;
  },
  signal: AbortSignal,
): Promise<DraftPull> {
  signal.throwIfAborted();
  const existing = await github.findPull(plan.head, base);
  if (existing) return existing;
  signal.throwIfAborted();
  await github.ensureBranch(plan);
  signal.throwIfAborted();
  try {
    return await github.createPull({
      head: plan.head, base, title: plan.title, body: plan.body, draft: plan.draft,
    });
  } catch (error) {
    signal.throwIfAborted();
    const recovered = await github.findPull(plan.head, base);
    if (recovered) return recovered;
    throw error;
  }
}

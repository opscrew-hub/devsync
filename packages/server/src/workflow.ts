/**
 * The names DevSync's runs share with the workflow file the user adds (docs/managed-runs.md, The
 * workflow's contract). The file's name and its two artifacts' are the workflow's own, from
 * `@devsync/schemas`; the rest are what the server reads of them.
 */
import { WORKFLOW_FILE } from "@devsync/schemas";

export { PATCH_ARTIFACT, RESULT_ARTIFACT, WORKFLOW_FILE } from "@devsync/schemas";

/** Where the user adds it in the repository. */
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
/** The `result.json` file in the `report` job's artifact. */
export const RESULT_FILE = "result.json";
/** The Actions secret with the workspace's own Anthropic key. */
export const API_KEY_SECRET = "ANTHROPIC_API_KEY";

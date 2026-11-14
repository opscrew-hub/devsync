/**
 * The names DevSync's runs share with the workflow file the user adds (docs/managed-runs.md, The
 * workflow's contract): the file in `.github/workflows/`, its two artifacts, and the Actions secret
 * its `agent` job reads.
 */

/** The workflow file `serverModule.workflows` declares and `host.github` starts. */
export const WORKFLOW_FILE = "devsync.yml";
/** Where the user adds it in the repository. */
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
/** The `report` job's artifact: `result.json`. */
export const RESULT_ARTIFACT = "devsync-result";
/** The `result.json` file in it. */
export const RESULT_FILE = "result.json";
/** The `agent` job's artifact: the change as a patch, for the `publish` job. */
export const PATCH_ARTIFACT = "devsync-patch";
/** The Actions secret with the workspace's own Anthropic key. */
export const API_KEY_SECRET = "ANTHROPIC_API_KEY";

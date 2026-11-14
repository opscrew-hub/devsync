import {
  can,
  Id,
  Run,
  type RunSetup,
  type RunStatus,
  type RunUsage,
  type TaskDetail,
  WORKFLOW,
  WORKFLOW_FILE,
} from "@devsync/schemas";
import { useId, useState } from "react";
import styles from "./devsync.module.css";
import { authorName, DialogButtons, formatTime, Problem } from "./parts";
import { type DevSyncIcon, useDevSync } from "./provider";
import { unended, useChange, useRunSetup, useRuns } from "./queries";

/** Where the user adds the workflow file in the repository. */
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
/** Only GitHub's own addresses become links; anything else is shown as text. */
const GITHUB = "https://github.com/";
/** How many changed files show before the rest fold away. */
const FILES_SHOWN = 10;

const STATUS: Record<RunStatus, [string, string, DevSyncIcon]> = {
  REQUESTED: ["Waiting for approval", "s-warning", "clock-counter-clockwise"],
  QUEUED: ["Approved, starting", "s-muted", "clock-counter-clockwise"],
  RUNNING: ["Running", "s-good", "arrows-clockwise"],
  SUCCEEDED: ["Succeeded", "s-good", "check-circle"],
  FAILED: ["Failed", "s-serious", "warning"],
  REJECTED: ["Rejected", "s-muted", "warning"],
  CANCELLED: ["Cancelled", "s-muted", "trash"],
};

const COUNT = new Intl.NumberFormat("en");
const USD = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** What an open dialog is for. */
type Open = { kind: "ask" } | { kind: "approve"; run: Run };

/**
 * The task's managed runs: what the repository still needs, asking for a run on a Ready task, and
 * the runs with their state, decisions and results.
 */
export function Runs({ task }: { task: TaskDetail }) {
  const { ui, may, role, userId } = useDevSync();
  const { Icon } = ui;
  const runs = useRuns(task.id);
  const setup = useRunSetup();
  const [open, setOpen] = useState<Open | null>(null);
  const heading = useId();
  const why = useId();
  const reject = useChange(Id, (api, runId) =>
    api.send("POST", `/runs/${runId}/reject`, undefined, Run),
  );
  const cancel = useChange(Id, (api, runId) =>
    api.send("POST", `/runs/${runId}/cancel`, undefined, Run),
  );
  const close = () => setOpen(null);
  const list = runs.data?.runs;
  const blocked = askBlocked(task, list, setup.data);
  const decide = may("run.decide");

  return (
    <section className={styles.stack} aria-labelledby={heading}>
      <h4 className={`cream ${styles.inline}`} id={heading}>
        <Icon name="robot" className="i-sm" />
        Managed runs
      </h4>
      <p className="sub">
        A run's inputs, this task's text, are visible to anyone who can see the repository's Actions
        runs.
      </p>
      <Setup setup={setup} />
      <div className={styles.buttons}>
        <button
          className="btn btn-sm btn-primary"
          type="button"
          disabled={!may("run.request") || !list || !setup.data || blocked !== null}
          aria-describedby={blocked ? why : undefined}
          onClick={() => setOpen({ kind: "ask" })}
        >
          <Icon name="paper-plane-tilt" className="i-sm" />
          Ask for a run
        </button>
      </div>
      {blocked && (
        <p className="sub" id={why}>
          {blocked}
        </p>
      )}
      <Problem error={runs.error ?? reject.error ?? cancel.error} />
      {list?.length === 0 && <p className="sub">No runs yet.</p>}
      {list && list.length > 0 && (
        <ul className="feed" aria-label="Runs">
          {list.map((run) => {
            // The requester may cancel whatever their role: `may("run.request")`, which every role
            // has, adds only a read-only project's lock.
            const mine = run.requestedBy.kind === "member" && run.requestedBy.userId === userId;
            return (
              <li key={run.id}>
                <Icon name="robot" />
                <div className={styles.stack}>
                  <RunFacts run={run} />
                  {run.status === "REQUESTED" && (
                    <>
                      <fieldset className={styles.buttons} aria-label="Decide on the run">
                        <button
                          className="btn btn-sm btn-primary"
                          type="button"
                          disabled={!decide}
                          onClick={() => setOpen({ kind: "approve", run })}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-sm btn-secondary bordered"
                          type="button"
                          disabled={!decide || reject.isPending}
                          onClick={() => reject.mutate(run.id)}
                        >
                          Reject
                        </button>
                        <button
                          className="btn btn-sm btn-danger bordered"
                          type="button"
                          disabled={!(decide || (mine && may("run.request"))) || cancel.isPending}
                          onClick={() => cancel.mutate(run.id)}
                        >
                          Cancel the run
                        </button>
                      </fieldset>
                      {!can(role, "run.decide") && (
                        <p className="sub">An Owner, Admin or Approver approves or rejects it.</p>
                      )}
                    </>
                  )}
                  <RunResult run={run} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open?.kind === "ask" && <Ask task={task} onClose={close} />}
      {open?.kind === "approve" && <Approve task={task} run={open.run} onClose={close} />}
    </section>
  );
}

/** Why a run can't be asked for now, or null when it can. */
function askBlocked(
  task: TaskDetail,
  runs: Run[] | undefined,
  setup: RunSetup | undefined,
): string | null {
  if (task.status !== "READY") {
    return "Only a Ready task can have a run: move this one to Ready first.";
  }
  if (runs?.some(unended)) return "This task has a run that hasn't ended yet.";
  if (setup && setup.missing.length > 0) return "Add what the setup lists above, then check again.";
  return null;
}

/**
 * What the repository still needs, in the server's words, with the workflow file to copy when it
 * is missing. Read when the section opens and on Check again only.
 */
function Setup({ setup }: { setup: ReturnType<typeof useRunSetup> }) {
  const { Icon } = useDevSync().ui;
  const data = setup.data;
  return (
    <div className={styles.stack}>
      {data && data.missing.length > 0 && (
        <>
          <p className={`status s-warning ${styles.problem}`}>
            <Icon name="warning" className="i-sm" />
            Before asking for a run, add to the repository:
          </p>
          <ul className={styles.steps}>
            {data.missing.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </>
      )}
      {data && !data.workflow && <WorkflowFile />}
      {data && data.missing.length === 0 && (
        <p className={`status s-good ${styles.problem}`}>
          <Icon name="check-circle" className="i-sm" />
          The repository has the workflow and the ANTHROPIC_API_KEY secret.
        </p>
      )}
      {data && (
        <p className="sub">
          A run opens its draft pull request only with Settings &gt; Actions &gt; General &gt; Allow
          GitHub Actions to create and approve pull requests turned on.
        </p>
      )}
      <Problem error={setup.error} />
      <div className={styles.buttons}>
        <button
          className="btn btn-sm btn-secondary bordered"
          type="button"
          disabled={setup.isFetching}
          onClick={() => void setup.refetch()}
        >
          <Icon name="arrows-clockwise" className="i-sm" />
          Check again
        </button>
      </div>
    </div>
  );
}

/** The workflow file in full, to copy to `.github/workflows/devsync.yml`. */
function WorkflowFile() {
  const { Icon } = useDevSync().ui;
  const [copied, setCopied] = useState(false);
  return (
    <figure className={`${styles.stack} ${styles.workflow}`}>
      <figcaption className={styles.inline}>
        <span className="mono cream">{WORKFLOW_PATH}</span>
        <button
          className="btn btn-sm btn-secondary bordered"
          type="button"
          onClick={() => void navigator.clipboard?.writeText(WORKFLOW).then(() => setCopied(true))}
        >
          <Icon name={copied ? "check-circle" : "copy"} className="i-sm" />
          {copied ? "Copied" : "Copy the workflow"}
        </button>
      </figcaption>
      <pre className={`mono ${styles.code}`}>{WORKFLOW}</pre>
    </figure>
  );
}

/** A run's revision, state, who asked for it and who decided. */
function RunFacts({ run }: { run: Run }) {
  const { Icon } = useDevSync().ui;
  const [label, tone, icon] = STATUS[run.status];
  const verb =
    run.status === "REJECTED" ? "Rejected" : run.status === "CANCELLED" ? "Cancelled" : "Approved";
  return (
    <>
      <p className={styles.inline}>
        <span className="cream">Revision {run.revision}</span>
        <span className={`status ${tone}`}>
          <Icon name={icon} className="i-sm" />
          {label}
        </span>
      </p>
      <p className="sub">
        Asked for by {authorName(run.requestedBy)}, {formatTime(run.createdAt)}
        {run.decidedBy &&
          ` · ${verb} by ${run.decidedBy.name}${run.decidedAt ? `, ${formatTime(run.decidedAt)}` : ""}`}
      </p>
    </>
  );
}

/** What a run left: why it failed, the files it changed, its usage and cost, and its links. */
function RunResult({ run }: { run: Run }) {
  const { Icon } = useDevSync().ui;
  const { failure, changedFiles, usage, draftPullRequestUrl, githubRunUrl } = run;
  return (
    <>
      {failure && (
        <p className={`status s-serious ${styles.problem}`}>
          <Icon name="warning" className="i-sm" />
          {failure.message}
        </p>
      )}
      {changedFiles && changedFiles.length > 0 && <ChangedFiles files={changedFiles} />}
      {(usage || draftPullRequestUrl || githubRunUrl) && (
        <dl className="kv">
          {usage && (
            <>
              <dt>Tokens</dt>
              <dd>{tokens(usage)}</dd>
              <dt>Cost, estimated</dt>
              <dd>{USD.format(usage.costUsd)}</dd>
              {usage.models.length > 0 && (
                <>
                  <dt>Models</dt>
                  <dd className="mono">{usage.models.join(", ")}</dd>
                </>
              )}
            </>
          )}
          {draftPullRequestUrl && (
            <>
              <dt>Draft pull request</dt>
              <dd>
                <GithubLink url={draftPullRequestUrl} />
              </dd>
            </>
          )}
          {githubRunUrl && (
            <>
              <dt>GitHub run</dt>
              <dd>
                <GithubLink url={githubRunUrl} />
              </dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

/** `12,000 input · 3,400 output · 50,000 cache read · 8,000 cache written`. */
function tokens(usage: RunUsage): string {
  return [
    `${COUNT.format(usage.inputTokens)} input`,
    `${COUNT.format(usage.outputTokens)} output`,
    `${COUNT.format(usage.cacheReadInputTokens)} cache read`,
    `${COUNT.format(usage.cacheCreationInputTokens)} cache written`,
  ].join(" · ");
}

/** The first files a run changed, and the rest folded away. */
function ChangedFiles({ files }: { files: string[] }) {
  const rest = files.slice(FILES_SHOWN);
  return (
    <div className={styles.stack}>
      <p className="sub">
        {files.length === 1 ? "1 changed file" : `${files.length} changed files`}
      </p>
      <FileList label="Changed files" files={files.slice(0, FILES_SHOWN)} />
      {rest.length > 0 && (
        <details>
          <summary>{rest.length === 1 ? "1 more file" : `${rest.length} more files`}</summary>
          <FileList label="More changed files" files={rest} />
        </details>
      )}
    </div>
  );
}

function FileList({ label, files }: { label: string; files: string[] }) {
  return (
    <ul className={styles.files} aria-label={label}>
      {files.map((file) => (
        <li key={file} className="mono">
          {file}
        </li>
      ))}
    </ul>
  );
}

/** A link to GitHub, in a new tab; an address anywhere else is only shown. */
function GithubLink({ url }: { url: string }) {
  if (!url.startsWith(GITHUB)) return <span className={`mono ${styles.prose}`}>{url}</span>;
  return (
    <a className="cream" href={url} target="_blank" rel="noopener noreferrer">
      {url.slice(GITHUB.length)}
    </a>
  );
}

/** A revision's title, description and acceptance criteria, exactly as a run is sent them. */
function RunText({
  text,
}: {
  text: { title: string; description: string; acceptanceCriteria: string };
}) {
  const empty = <span className="sub">Empty</span>;
  return (
    <dl className={styles.sent}>
      <dt className="sub">Title</dt>
      <dd className={`cream ${styles.prose}`}>{text.title}</dd>
      <dt className="sub">Description</dt>
      <dd className={styles.prose}>{text.description || empty}</dd>
      <dt className="sub">Acceptance criteria</dt>
      <dd className={styles.prose}>{text.acceptanceCriteria || empty}</dd>
    </dl>
  );
}

function Ask({ task, onClose }: { task: TaskDetail; onClose: () => void }) {
  const { Dialog } = useDevSync().ui;
  const request = useChange(Id, (api, taskId) =>
    api.send("POST", `/tasks/${taskId}/runs`, undefined, Run),
  );
  return (
    <Dialog
      title="Ask for a run"
      icon="robot"
      onSubmit={(event) => {
        event.preventDefault();
        request.mutate(task.id, { onSuccess: onClose });
      }}
    >
      <p className="sub">
        Once an Owner, Admin or Approver approves it, Claude Code works on revision {task.revision}{" "}
        of this task in the repository's Actions and opens a draft pull request. The run is sent
        this text:
      </p>
      <RunText text={task} />
      <Problem error={request.error} />
      <DialogButtons label="Ask for the run" pending={request.isPending} onCancel={onClose} />
    </Dialog>
  );
}

function Approve({ task, run, onClose }: { task: TaskDetail; run: Run; onClose: () => void }) {
  const { Dialog } = useDevSync().ui;
  const approve = useChange(Id, (api, runId) =>
    api.send("POST", `/runs/${runId}/approve`, undefined, Run),
  );
  const revision = task.revisions.find((r) => r.number === run.revision);
  return (
    <Dialog
      title="Approve the run"
      icon="check-circle"
      onSubmit={(event) => {
        event.preventDefault();
        approve.mutate(run.id, { onSuccess: onClose });
      }}
    >
      <p className="sub">
        Claude Code then works on revision {run.revision} of this task, as{" "}
        {authorName(run.requestedBy)} asked for it, in the repository's Actions and on its
        ANTHROPIC_API_KEY secret. The run is sent this text:
      </p>
      {revision ? (
        <RunText text={revision} />
      ) : (
        <p className="sub">Reload the task to read revision {run.revision}'s text.</p>
      )}
      <Problem error={approve.error} />
      <DialogButtons label="Approve the run" pending={approve.isPending} onCancel={onClose} />
    </Dialog>
  );
}

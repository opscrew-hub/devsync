import {
  AnswerInput,
  Comment,
  CommentInput,
  LIMITS,
  PullRequestLink,
  Question,
  QuestionInput,
  STATUS_LABEL,
  Task,
  type TaskDetail,
  type TaskStatus,
  type TaskSummary,
  TaskUpdate,
  type TimelineEvent,
  TRANSITIONS,
  type UsageTotal,
} from "@devsync/schemas";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { DevSyncRequestError } from "./client";
import styles from "./devsync.module.css";
import {
  authorName,
  Field,
  FORMER_MEMBER,
  formatTime,
  GithubLink,
  Problem,
  RequirementFields,
  requirements,
} from "./parts";
import { useDevSync } from "./provider";
import { useChange, useMembers, usePullRequests, useTask, useTasks } from "./queries";
import { type Repository, Runs } from "./Runs";

/**
 * The open task: its requirements, its questions, its paths, the tasks it waits for, its labels and
 * branch, its status, assignee, pull request, managed runs, usage, revisions, comments and timeline.
 */
export function TaskPanel({
  taskId,
  repository,
  onClose,
}: {
  taskId: string;
  /** The project's repository, which the runs section's setup links to. */
  repository?: Repository;
  onClose: () => void;
}) {
  const { ui } = useDevSync();
  const task = useTask(taskId);
  const panel = useRef<HTMLElement>(null);
  const heading = useId();

  // The panel takes the focus when it opens, so the keyboard and screen readers land on it.
  useEffect(() => panel.current?.focus(), []);

  return (
    <section
      ref={panel}
      className={`card bordered ${styles.panel}`}
      tabIndex={-1}
      aria-labelledby={heading}
    >
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <ui.Icon name="kanban" />
          {task.data?.title ?? "Task"}
        </h3>
        <button className="btn btn-sm btn-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <Problem error={task.error} />
      {task.data && <TaskBody task={task.data} repository={repository} />}
    </section>
  );
}

/** `PATCH /tasks/:taskId`: an edit, a move or an assignment, against the version it sends. */
function useTaskUpdate(taskId: string) {
  return useChange(TaskUpdate, (api, body) => api.send("PATCH", `/tasks/${taskId}`, body, Task));
}

/**
 * A form's save against the version read when it opened: if someone else saved first, the API
 * refuses, the form keeps what was typed, and `reload` reads the task again to save over it.
 */
function useFormSave(task: TaskDetail) {
  const [version, setVersion] = useState(task.version);
  const latest = useTask(task.id);
  const save = useTaskUpdate(task.id);
  const conflict = save.error instanceof DevSyncRequestError && save.error.code === "conflict";
  const reload = async () => {
    const fresh = await latest.refetch();
    if (fresh.data) setVersion(fresh.data.version);
    save.reset();
  };
  return { version, save, conflict, reload };
}

/** A form's Reload (after a conflict), Cancel and save buttons. */
function FormButtons({
  label,
  form,
  onDone,
}: {
  label: string;
  form: ReturnType<typeof useFormSave>;
  onDone: () => void;
}) {
  return (
    <div className={styles.actions}>
      {form.conflict && (
        <button className="btn btn-sm btn-ghost" type="button" onClick={form.reload}>
          Reload the task
        </button>
      )}
      <button className="btn btn-sm btn-secondary bordered" type="button" onClick={onDone}>
        Cancel
      </button>
      <button className="btn btn-sm btn-primary" type="submit" disabled={form.save.isPending}>
        {label}
      </button>
    </div>
  );
}

function TaskBody({ task, repository }: { task: TaskDetail; repository?: Repository }) {
  const { may } = useDevSync();
  const write = may("task.write");
  // A Done or Cancelled task's requirements no longer change; the server refuses it too.
  const closed = CLOSED.includes(task.status);
  const [editing, setEditing] = useState(false);
  const update = useTaskUpdate(task.id);
  // Moves and assignments go with the version last read; a refusal reloads the task.
  const change = (fields: Omit<TaskUpdate, "version">) =>
    update.mutate({ ...fields, version: task.version });

  return (
    <>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <span className="chip">{STATUS_LABEL[task.status]}</span>
        </dd>
        <dt>Revision</dt>
        <dd>{task.revision}</dd>
        <dt>Created by</dt>
        <dd>
          {authorName(task.creator)}, {formatTime(task.createdAt)}
        </dd>
        {task.claim && (
          <>
            <dt>Claimed by</dt>
            <dd>
              {task.claim.agentName}, until {formatTime(task.claim.expiresAt)}
            </dd>
          </>
        )}
      </dl>

      {editing ? (
        <EditRequirements task={task} onDone={() => setEditing(false)} />
      ) : (
        <div className={styles.stack}>
          <h4 className="cream">Description</h4>
          <p className={styles.prose}>{task.description || "No description."}</p>
          <h4 className="cream">Acceptance criteria</h4>
          <p className={styles.prose}>{task.acceptanceCriteria || "No acceptance criteria."}</p>
          {closed && (
            <p className="sub">{`This task is ${STATUS_LABEL[task.status]}: its requirements stay as they are.`}</p>
          )}
          <div className={styles.buttons}>
            <button
              className="btn btn-sm btn-secondary bordered"
              type="button"
              disabled={!write || closed}
              onClick={() => setEditing(true)}
            >
              Edit the requirements
            </button>
          </div>
        </div>
      )}

      <Questions task={task} />
      <TaskScope task={task} />
      <Moves
        task={task}
        disabled={!write || update.isPending}
        onMove={(status) => change({ status })}
      />
      <Assignee
        task={task}
        disabled={!write || update.isPending}
        onAssign={(id) => change({ assigneeUserId: id })}
      />
      <Problem error={update.error} />
      <PullRequestPicker task={task} />
      <Runs task={task} repository={repository} />
      <Usage usage={task.usage} />
      <Revisions task={task} />
      <Comments task={task} />
      <Timeline events={task.timeline} />
    </>
  );
}

/**
 * Edits the requirements against the version read when the form opened: if someone else saved
 * first, the API refuses and the person's text stays in the form until they reload the task.
 */
function EditRequirements({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const form = useFormSave(task);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = requirements(new FormData(event.currentTarget));
    form.save.mutate({ ...fields, version: form.version }, { onSuccess: onDone });
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Edit the requirements">
      <RequirementFields initial={task} />
      <Problem error={form.save.error} />
      <FormButtons label="Save the requirements" form={form} onDone={onDone} />
    </form>
  );
}

/** A task that is no longer open: it holds no claim back and shares no paths. */
const CLOSED: readonly TaskStatus[] = ["DONE", "CANCELLED"];

/**
 * The task's questions, as the server orders them (the open ones first), each with who asked it
 * and its answer, and how many older answered ones the server leaves out. An open one has its
 * answer form, and an open task the form to ask another, both locked for a role without
 * `task.write` and on a read-only or disconnected project. "The task waits for its answer" shows
 * only on a question still holding the task in Blocked.
 */
function Questions({ task }: { task: TaskDetail }) {
  const { ui, may } = useDevSync();
  const heading = useId();
  const write = may("task.write");
  const ask = useChange(QuestionInput, (api, body) =>
    api.send("POST", `/tasks/${task.id}/questions`, body, Question),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    ask.mutate({ text: new FormData(form).get("text") }, { onSuccess: () => form.reset() });
  }

  return (
    <section className={styles.stack} aria-labelledby={heading}>
      <h4 className={`cream ${styles.inline}`} id={heading}>
        <ui.Icon name="chat-circle-text" className="i-sm" />
        Questions
      </h4>
      {task.questions.length === 0 && <p className="sub">No questions yet.</p>}
      <ul className="feed" aria-label="Questions">
        {task.questions.map((question) => (
          <QuestionItem key={question.id} question={question} write={write} />
        ))}
      </ul>
      {task.answeredNotShown > 0 && (
        <p className="sub">
          {task.answeredNotShown === 1
            ? "1 older answered question isn't shown."
            : `${task.answeredNotShown} older answered questions aren't shown.`}
        </p>
      )}
      {CLOSED.includes(task.status) ? (
        <p className="sub">{`A ${STATUS_LABEL[task.status]} task takes no more questions.`}</p>
      ) : (
        <form className={styles.form} onSubmit={submit} aria-label="Ask a question">
          <Field label="Question">
            <textarea
              className="field"
              name="text"
              rows={3}
              required
              maxLength={LIMITS.question}
              disabled={!write}
            />
          </Field>
          <Problem error={ask.error} />
          <div className={styles.actions}>
            <button
              className="btn btn-sm btn-primary"
              type="submit"
              disabled={!write || ask.isPending}
            >
              Ask the question
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** One question: who asked it and when, its text, and its answer or the form to answer it. */
function QuestionItem({ question, write }: { question: Question; write: boolean }) {
  const { ui } = useDevSync();
  const post = useChange(AnswerInput, (api, body) =>
    api.send("POST", `/questions/${question.id}/answer`, body, Question),
  );
  const open = question.status === "OPEN";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    post.mutate({ answer: new FormData(form).get("answer") }, { onSuccess: () => form.reset() });
  }

  return (
    <li>
      <ui.Icon name={question.askedBy.kind === "agent" ? "robot" : "chat-circle-text"} />
      <div className={styles.stack}>
        <p className="sub">
          {authorName(question.askedBy)}, {formatTime(question.createdAt)}{" "}
          <span className="chip">
            {open ? (question.wait ? "Open: the task waits for its answer" : "Open") : "Answered"}
          </span>
        </p>
        <p className={styles.prose}>{question.text}</p>
        {open ? (
          <form className={styles.form} onSubmit={submit} aria-label="Answer the question">
            <Field label="Answer">
              <textarea
                className="field"
                name="answer"
                rows={2}
                required
                maxLength={LIMITS.question}
                disabled={!write}
              />
            </Field>
            <Problem error={post.error} />
            <div className={styles.actions}>
              <button
                className="btn btn-sm btn-primary"
                type="submit"
                disabled={!write || post.isPending}
              >
                Post the answer
              </button>
            </div>
          </form>
        ) : (
          <>
            <p className="sub">
              Answered by {authorName(question.answeredBy)}
              {question.answeredAt && `, ${formatTime(question.answeredAt)}`}
            </p>
            <p className={styles.prose}>{question.answer}</p>
          </>
        )}
      </div>
    </li>
  );
}

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"`. */
function titles(tasks: readonly TaskSummary[]): string {
  const names = tasks.map((t) => `"${t.title}"`);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : `${names[0]}`;
}

/**
 * The task's paths, the tasks it waits for, its labels and branch, and their edit: none of them is
 * part of the requirements, so editing them makes no revision. It says what the task waits for
 * while one of those is open, and flags the other open tasks whose paths overlap its own.
 */
function TaskScope({ task }: { task: TaskDetail }) {
  const { ui, may } = useDevSync();
  const [editing, setEditing] = useState(false);
  const heading = useId();
  const open = task.dependencies.filter((d) => !CLOSED.includes(d.status));
  const overlaps = task.overlaps.length;

  return (
    <section className={styles.stack} aria-labelledby={heading}>
      <h4 className="cream" id={heading}>
        Paths and dependencies
      </h4>
      {open.length > 0 && (
        <p className={`status s-warning ${styles.problem}`} role="status">
          <ui.Icon name="clock-counter-clockwise" className="i-sm" />
          {`Waits for ${titles(open)}: agents can claim it once ${open.length === 1 ? "that is" : "they are"} done.`}
        </p>
      )}
      {overlaps > 0 && (
        <>
          <p className={`status s-warning ${styles.problem}`}>
            <ui.Icon name="warning" className="i-sm" />
            {`Shares paths with ${overlaps} other open ${overlaps === 1 ? "task" : "tasks"}:`}
          </p>
          <ul className={styles.steps} aria-label="Overlapping tasks">
            {task.overlaps.map(({ task: other, paths }) => (
              <li key={other.id}>
                {`${other.title} (${STATUS_LABEL[other.status]}): `}
                <span className="mono">{paths.join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {editing ? (
        <EditScope task={task} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="kv">
            <dt>Paths</dt>
            <dd>
              {task.owns.length === 0 ? (
                "No paths given."
              ) : (
                <ul className={styles.files} aria-label="Paths">
                  {task.owns.map((path) => (
                    <li key={path} className="mono">
                      {path}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Waits for</dt>
            <dd>
              {task.dependencies.length === 0 ? (
                "No other task."
              ) : (
                <ul className={styles.files} aria-label="Waits for">
                  {task.dependencies.map((d) => (
                    <li key={d.id}>{`${d.title} (${STATUS_LABEL[d.status]})`}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Labels</dt>
            <dd>
              {task.labels.length === 0 ? (
                "None."
              ) : (
                <span className={styles.buttons}>
                  {task.labels.map((label) => (
                    <span key={label} className="chip">
                      {label}
                    </span>
                  ))}
                </span>
              )}
            </dd>
            <dt>Branch</dt>
            <dd>{task.branch ? <span className="mono">{task.branch}</span> : "None."}</dd>
          </dl>
          <div className={styles.buttons}>
            <button
              className="btn btn-sm btn-secondary bordered"
              type="button"
              disabled={!may("task.write")}
              onClick={() => setEditing(true)}
            >
              Edit the fields
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A textarea's lines, trimmed, without empty ones, each once (by `key`, the first kept). */
function lines(text: FormDataEntryValue | null, key = (line: string) => line): string[] {
  const seen = new Set<string>();
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (line === "" || seen.has(key(line))) return false;
      seen.add(key(line));
      return true;
    });
}

/**
 * Edits the paths (one per line), the tasks it waits for (the project's other open tasks, and those
 * it already waits for), the labels (one per line) and the branch, saved together against the
 * version read when the form opened.
 */
function EditScope({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const form = useFormSave(task);
  const listed = useTasks().data?.tasks ?? [];
  const [waitsFor, setWaitsFor] = useState<string[]>(task.dependsOn);
  const choices: TaskSummary[] = [
    ...listed.filter(
      (t) => t.id !== task.id && (!CLOSED.includes(t.status) || task.dependsOn.includes(t.id)),
    ),
    ...task.dependencies.filter((d) => !listed.some((t) => t.id === d.id)),
  ];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const branch = String(data.get("branch") ?? "").trim();
    form.save.mutate(
      {
        version: form.version,
        owns: lines(data.get("owns")),
        dependsOn: waitsFor,
        labels: lines(data.get("labels"), (label) => label.toLowerCase()),
        branch: branch === "" ? null : branch,
      },
      { onSuccess: onDone },
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Edit the fields">
      <Field label="Paths it may change, one per line">
        <textarea
          className="field mono"
          name="owns"
          rows={4}
          defaultValue={task.owns.join("\n")}
          placeholder="src/checkout/"
        />
      </Field>
      <Field label="Waits for">
        <select
          className="field"
          multiple
          size={Math.min(6, Math.max(2, choices.length))}
          value={waitsFor}
          onChange={(event) =>
            setWaitsFor(Array.from(event.target.selectedOptions, (option) => option.value))
          }
        >
          {choices.map((t) => (
            <option key={t.id} value={t.id}>
              {`${t.title} (${STATUS_LABEL[t.status]})`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Labels, one per line">
        <textarea className="field" name="labels" rows={2} defaultValue={task.labels.join("\n")} />
      </Field>
      <Field label="Branch">
        <input className="field mono" name="branch" defaultValue={task.branch ?? ""} />
      </Field>
      <Problem error={form.save.error} />
      <FormButtons label="Save the fields" form={form} onDone={onDone} />
    </form>
  );
}

const COUNT = new Intl.NumberFormat("en");
const USD = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** `12,000 input · 3,400 output · 50,000 cache read · 8,000 cache written · ≈ $0.42`. */
function usageLine(total: UsageTotal): string {
  return [
    `${COUNT.format(total.inputTokens)} input`,
    `${COUNT.format(total.outputTokens)} output`,
    `${COUNT.format(total.cacheReadInputTokens)} cache read`,
    `${COUNT.format(total.cacheCreationInputTokens)} cache written`,
    `≈ ${USD.format(total.costUsd)}`,
  ].join(" · ");
}

function models(total: UsageTotal): string {
  return total.models.length > 0 ? ` (${total.models.join(", ")})` : "";
}

/**
 * What the task's agents reported they used (their own estimates) beside what its managed runs
 * used, kept apart; nothing while neither reported any.
 */
function Usage({ usage }: { usage: TaskDetail["usage"] }) {
  const heading = useId();
  const { agents, runs } = usage;
  if (!agents && !runs) return null;
  return (
    <section className={styles.stack} aria-labelledby={heading}>
      <h4 className="cream" id={heading}>
        Usage
      </h4>
      <dl className="kv">
        {agents && (
          <>
            <dt>Agents' reports</dt>
            <dd>
              {`${usageLine(agents)}, the agents' own estimate, from ${agents.count} ${agents.count === 1 ? "report" : "reports"}${models(agents)}`}
            </dd>
          </>
        )}
        {runs && (
          <>
            <dt>Managed runs</dt>
            <dd>
              {`${usageLine(runs)}, from ${runs.count} ${runs.count === 1 ? "run" : "runs"}${models(runs)}`}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** The moves the lifecycle allows; a task an agent holds only by being cancelled. */
function Moves({
  task,
  disabled,
  onMove,
}: {
  task: TaskDetail;
  disabled: boolean;
  onMove: (status: TaskStatus) => void;
}) {
  const held = task.claim !== null && Date.parse(task.claim.expiresAt) > Date.now();
  const moves = TRANSITIONS[task.status].filter((to) => !held || to === "CANCELLED");
  if (moves.length === 0) return null;
  return (
    <fieldset className={styles.moves}>
      <legend className="cream">Move to</legend>
      <div className={styles.buttons}>
        {moves.map((to) => (
          <button
            key={to}
            className={`btn btn-sm ${to === "CANCELLED" ? "btn-danger" : "btn-secondary"} bordered`}
            type="button"
            disabled={disabled}
            onClick={() => onMove(to)}
          >
            {STATUS_LABEL[to]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Assignee({
  task,
  disabled,
  onAssign,
}: {
  task: TaskDetail;
  disabled: boolean;
  onAssign: (userId: string | null) => void;
}) {
  const members = useMembers().data?.members ?? [];
  const current = task.assigneeUserId ?? "";
  const known = current === "" || members.some((m) => m.userId === current);
  return (
    <Field label="Assignee">
      <select
        className="field"
        value={current}
        disabled={disabled}
        onChange={(event) => onAssign(event.target.value || null)}
      >
        <option value="">Unassigned</option>
        {!known && <option value={current}>{FORMER_MEMBER}</option>}
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

const PR_STATE = { open: "Open", closed: "Closed", merged: "Merged" } as const;

/** The linked pull request with its state as GitHub reports it, and the picker to change it. */
function PullRequestPicker({ task }: { task: TaskDetail }) {
  const { ui, may } = useDevSync();
  const pulls = usePullRequests().data?.pullRequests ?? [];
  const link = useChange(PullRequestLink, (api, body) =>
    api.send("PUT", `/tasks/${task.id}/pull-request`, body, Task),
  );
  const linked = task.pullRequest;
  const current = task.pullRequestNumber;
  const listed = current === null || pulls.some((pr) => pr.number === current);

  return (
    <div className={styles.stack}>
      <h4 className={`cream ${styles.inline}`}>
        <ui.Icon name="git-pull-request" className="i-sm" />
        Pull request
      </h4>
      {linked ? (
        <p>
          <GithubLink url={linked.url}>
            #{linked.number} {linked.title}
          </GithubLink>{" "}
          <span className="chip">{PR_STATE[linked.state]}</span>
        </p>
      ) : (
        current === null && <p className="sub">No pull request linked.</p>
      )}
      <Field label="Linked pull request">
        <select
          className="field"
          value={current ?? ""}
          disabled={!may("task.write") || link.isPending}
          onChange={(event) =>
            link.mutate({ number: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">None</option>
          {!listed && <option value={current ?? ""}>#{current}</option>}
          {pulls.map((pr) => (
            <option key={pr.number} value={pr.number}>
              #{pr.number} {pr.title} ({PR_STATE[pr.state]})
            </option>
          ))}
        </select>
      </Field>
      <Problem error={link.error} />
    </div>
  );
}

function Revisions({ task }: { task: TaskDetail }) {
  const { Icon } = useDevSync().ui;
  return (
    <div className={styles.stack}>
      <h4 className={`cream ${styles.inline}`}>
        <Icon name="clock-counter-clockwise" className="i-sm" />
        Revisions
      </h4>
      <ul className="feed" aria-label="Revisions">
        {task.revisions.map((revision) => (
          <li key={revision.number}>
            <Icon name="clock-counter-clockwise" />
            <details>
              <summary>
                Revision {revision.number} by {authorName(revision.author)},{" "}
                {formatTime(revision.createdAt)}
              </summary>
              <p className="cream">{revision.title}</p>
              <p className={styles.prose}>{revision.description || "No description."}</p>
              <p className={styles.prose}>
                {revision.acceptanceCriteria || "No acceptance criteria."}
              </p>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Comments({ task }: { task: TaskDetail }) {
  const { ui, may } = useDevSync();
  const post = useChange(CommentInput, (api, body) =>
    api.send("POST", `/tasks/${task.id}/comments`, body, Comment),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    post.mutate({ body: new FormData(form).get("body") }, { onSuccess: () => form.reset() });
  }

  return (
    <div className={styles.stack}>
      <h4 className={`cream ${styles.inline}`}>
        <ui.Icon name="chat-circle-text" className="i-sm" />
        Comments
      </h4>
      {task.comments.length === 0 && <p className="sub">No comments yet.</p>}
      <ul className="feed" aria-label="Comments">
        {task.comments.map((comment) => (
          <li key={comment.id}>
            <ui.Icon name={comment.author.kind === "agent" ? "robot" : "chat-circle-text"} />
            <div>
              <p className="sub">
                {comment.author.name}, {formatTime(comment.createdAt)}
              </p>
              <p className={styles.prose}>{comment.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <form className={styles.form} onSubmit={submit}>
        <Field label="Comment">
          <textarea
            className="field"
            name="body"
            rows={3}
            required
            maxLength={LIMITS.comment}
            disabled={!may("task.write")}
          />
        </Field>
        <Problem error={post.error} />
        <div className={styles.actions}>
          <button
            className="btn btn-sm btn-primary"
            type="submit"
            disabled={!may("task.write") || post.isPending}
          >
            Post the comment
          </button>
        </div>
      </form>
    </div>
  );
}

/** `task.status_changed` as "Task status changed", for kinds the page has no words of its own for. */
const EVENT: Record<string, string> = {
  "implementation.progress": "Progress reported",
  "task.blocked": "Blocker reported",
  "review.requested": "Review requested",
  "review.approved": "Review approved",
  "review.changes_requested": "Changes requested",
  "question.asked": "Question asked",
  "question.answered": "Question answered",
};

function eventLabel(kind: string): string {
  const known = EVENT[kind];
  if (known) return known;
  const words = kind.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const { Icon } = useDevSync().ui;
  return (
    <div className={styles.stack}>
      <h4 className="cream">Timeline</h4>
      {events.length === 0 && <p className="sub">Nothing has happened yet.</p>}
      <ol className="feed" aria-label="Timeline">
        {events.map((event) => (
          <li key={event.id}>
            <Icon
              name={
                event.actor === null
                  ? "git-pull-request"
                  : event.actor.kind === "agent"
                    ? "robot"
                    : "clock-counter-clockwise"
              }
            />
            <div>
              <p className="cream">
                {eventLabel(event.kind)}
                {event.revision !== null && ` (revision ${event.revision})`}
              </p>
              <p className="sub">
                {authorName(event.actor)}, {formatTime(event.createdAt)}
              </p>
              {event.message && <p className={styles.prose}>{event.message}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

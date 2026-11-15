import {
  type DismissalReason,
  type Finding,
  type FindingSeverity,
  LIMITS,
  type Member,
  STATUS_LABEL,
  Task,
  TaskInput,
  TaskStatus,
} from "@devsync/schemas";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Agents } from "./Agents";
import styles from "./devsync.module.css";
import { DialogButtons, memberName, Problem, RequirementFields, requirements } from "./parts";
import { useDevSync } from "./provider";
import { useChange, useFinding, useMembers, useTasks } from "./queries";
import type { Repository } from "./Runs";
import { TaskPanel } from "./TaskPanel";

export interface ProjectTabProps {
  /** The task open in the panel, kept in the host's URL (`?task=<id>`), or null. */
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  /** The project's repository, which the open task's runs section links to. */
  repository?: Repository;
  /** The fingerprint of a security finding to make a task from (`?finding=`), or null. */
  finding?: string | null;
  /** Leaves the finding: opening `taskId` (its linked or new task), or with null once closed. */
  onFindingDone?: (taskId: string | null) => void;
}

/**
 * A project's DevSync tab: its tasks by status and its agents, the open task's panel beside them,
 * and the task offered from a security finding. The list and the agents keep their place in the
 * page whether a task is open or not, so opening one doesn't mount them again.
 */
export function ProjectTab({
  selectedTaskId,
  onSelectTask,
  repository,
  finding,
  onFindingDone,
}: ProjectTabProps) {
  return (
    <div className={styles.page}>
      <div className={selectedTaskId ? styles.split : undefined}>
        <div className={styles.side}>
          <TaskList selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
          <Agents className={styles.agents} />
        </div>
        {selectedTaskId && (
          <TaskPanel
            key={selectedTaskId}
            taskId={selectedTaskId}
            repository={repository}
            onClose={() => onSelectTask(null)}
          />
        )}
      </div>
      {finding && onFindingDone && (
        <FindingTask key={finding} fingerprint={finding} onDone={onFindingDone} />
      )}
    </div>
  );
}

function TaskList({ selectedTaskId, onSelectTask }: ProjectTabProps) {
  const { ui, may } = useDevSync();
  const { Icon, EmptyState } = ui;
  const tasks = useTasks();
  const members = useMembers();
  const [creating, setCreating] = useState(false);
  const write = may("task.write");
  const heading = useId();

  const newTask = (
    <button
      className="btn btn-sm btn-primary"
      type="button"
      disabled={!write}
      onClick={() => setCreating(true)}
    >
      <Icon name="plus" className="i-sm" />
      New task
    </button>
  );
  const list = tasks.data?.tasks ?? [];
  // One button: the empty state's while there is no task yet, the header's afterwards.
  const empty = tasks.isSuccess && list.length === 0;

  return (
    <section className="card bordered" aria-labelledby={heading}>
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <Icon name="kanban" />
          Tasks
        </h3>
        {!empty && newTask}
      </div>
      <Problem error={tasks.error} />
      {empty && (
        <EmptyState icon="kanban" title="No tasks yet" action={newTask}>
          Write down what this project should do next; your people and coding agents pick it up.
        </EmptyState>
      )}
      {TaskStatus.options.map((status) => {
        const group = list.filter((task) => task.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} className={styles.group} aria-label={STATUS_LABEL[status]}>
            <h4 className={styles.groupHead}>
              {STATUS_LABEL[status]}
              <span className="chip">{group.length}</span>
            </h4>
            <ul>
              {group.map((task) => (
                <li key={task.id}>
                  <button
                    className={styles.row}
                    type="button"
                    aria-current={task.id === selectedTaskId ? "true" : undefined}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span className="cream">{task.title}</span>
                    <span className="sub">{describe(task, members.data?.members)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {creating && (
        <NewTask
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            setCreating(false);
            onSelectTask(task.id);
          }}
        />
      )}
    </section>
  );
}

/** `Ana Lima · claimed by Builder · #42`. */
function describe(task: Task, members: Member[] | undefined): string {
  return [
    task.assigneeUserId ? memberName(members, task.assigneeUserId) : "Unassigned",
    task.claim && `claimed by ${task.claim.agentName}`,
    task.pullRequestNumber && `#${task.pullRequestNumber}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The new task's dialog; from a security finding, prefilled from it, saying when it is marked
 * "Not a problem", and sending its fingerprint with the task. A member who may not write tasks sees
 * it with Create disabled.
 */
function NewTask({
  finding,
  onClose,
  onCreated,
}: {
  finding?: Finding;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const { ui, may } = useDevSync();
  const { Dialog, Icon } = ui;
  const create = useChange(TaskInput, (api, input) => api.send("POST", "/tasks", input, Task));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = requirements(new FormData(event.currentTarget));
    const input = finding ? { ...fields, finding: { fingerprint: finding.fingerprint } } : fields;
    create.mutate(input, { onSuccess: onCreated });
  }

  return (
    <Dialog title="New task" icon="plus" onSubmit={submit}>
      {finding?.dismissal && (
        <p className={`status s-muted ${styles.problem}`}>
          <Icon name="check-circle" className="i-sm" />
          Marked “Not a problem” ({DISMISSAL[finding.dismissal.reason]}).
        </p>
      )}
      <RequirementFields initial={finding && findingRequirements(finding)} />
      <Problem error={create.error} />
      <DialogButtons
        label="Create the task"
        pending={create.isPending}
        disabled={!may("task.write")}
        onCancel={onClose}
      />
    </Dialog>
  );
}

const DISMISSAL: Record<DismissalReason, string> = {
  "false-positive": "false positive",
  "accepted-risk": "accepted risk",
};

const SEVERITY: Record<FindingSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** `text`, cut to `max` characters ending with "…" when it is longer. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A new task's requirements from a finding, each within DevSync's limits. */
function findingRequirements(finding: Finding) {
  const where = finding.file && (finding.line ? `${finding.file}:${finding.line}` : finding.file);
  const facts = [
    where && `Where: ${where}`,
    `Severity: ${SEVERITY[finding.severity]}`,
    `Rule: ${finding.ruleId}`,
  ];
  const description = [
    finding.description,
    facts.filter(Boolean).join("\n"),
    finding.remediation && `How to fix it:\n${finding.remediation}`,
  ];
  const at = finding.file ? ` at ${finding.file}` : "";
  return {
    title: cut(`Fix: ${finding.title}`, LIMITS.title),
    description: cut(description.filter(Boolean).join("\n\n"), LIMITS.description),
    acceptanceCriteria: `The next security scan no longer reports ${finding.ruleId}${at}.`,
  };
}

/**
 * The task from the security finding `fingerprint`: its linked task opens instead when it has one,
 * else the new task's dialog is offered prefilled; a finding the server doesn't find (resolved, or
 * another project's) is said so, offering nothing. `onDone` leaves the finding.
 */
function FindingTask({
  fingerprint,
  onDone,
}: {
  fingerprint: string;
  onDone: (taskId: string | null) => void;
}) {
  const { Dialog } = useDevSync().ui;
  const found = useFinding(fingerprint);
  const linked = found.data?.task?.id;

  useEffect(() => {
    if (linked) onDone(linked);
  }, [linked, onDone]);

  if (found.error) {
    return (
      <Dialog title="Security finding" icon="warning">
        <Problem error={found.error} />
        <div className={styles.actions}>
          <button className="btn btn-secondary bordered" type="button" onClick={() => onDone(null)}>
            Close
          </button>
        </div>
      </Dialog>
    );
  }
  if (!found.data || found.data.task) return null;
  return (
    <NewTask
      finding={found.data.finding}
      onClose={() => onDone(null)}
      onCreated={(task) => onDone(task.id)}
    />
  );
}

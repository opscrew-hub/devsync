import { STATUS_LABEL, Task, TaskInput, TaskStatus } from "@devsync/schemas";
import { type FormEvent, useId, useState } from "react";
import { Agents } from "./Agents";
import styles from "./devsync.module.css";
import { DialogButtons, memberName, Problem, RequirementFields } from "./parts";
import { useDevSync } from "./provider";
import { useChange, useMembers, useTasks } from "./queries";
import { TaskPanel } from "./TaskPanel";

export interface ProjectTabProps {
  /** The task open in the panel, kept in the host's URL (`?task=<id>`), or null. */
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
}

/** A project's DevSync tab: its tasks by status, the open task's panel, and its agents. */
export function ProjectTab({ selectedTaskId, onSelectTask }: ProjectTabProps) {
  return (
    <div className={styles.page}>
      <div className={selectedTaskId ? styles.split : undefined}>
        <TaskList selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
        {selectedTaskId && (
          <TaskPanel
            key={selectedTaskId}
            taskId={selectedTaskId}
            onClose={() => onSelectTask(null)}
          />
        )}
      </div>
      <Agents />
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

  return (
    <section className="card bordered" aria-labelledby={heading}>
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <Icon name="kanban" />
          Tasks
        </h3>
        {newTask}
      </div>
      <Problem error={tasks.error} />
      {tasks.isSuccess && list.length === 0 && (
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
function describe(task: Task, members: Parameters<typeof memberName>[0]): string {
  return [
    task.assigneeUserId ? memberName(members, task.assigneeUserId) : "Unassigned",
    task.claim && `claimed by ${task.claim.agentName}`,
    task.pullRequestNumber && `#${task.pullRequestNumber}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function NewTask({ onClose, onCreated }: { onClose: () => void; onCreated: (task: Task) => void }) {
  const { Dialog } = useDevSync().ui;
  const create = useChange((api, input: TaskInput) => api.send("POST", "/tasks", input, Task));
  const [invalid, setInvalid] = useState<Error | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = TaskInput.safeParse({
      title: form.get("title"),
      description: form.get("description"),
      acceptanceCriteria: form.get("acceptanceCriteria"),
    });
    if (!input.success) {
      setInvalid(new Error("Give the task a title, and keep each field within its limit."));
      return;
    }
    setInvalid(null);
    create.mutate(input.data, { onSuccess: onCreated });
  }

  return (
    <Dialog title="New task" icon="plus" onSubmit={submit}>
      <RequirementFields />
      <Problem error={invalid ?? create.error} />
      <DialogButtons label="Create the task" pending={create.isPending} onCancel={onClose} />
    </Dialog>
  );
}

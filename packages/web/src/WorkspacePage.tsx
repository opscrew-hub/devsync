import { STATUS_LABEL, TaskStatus } from "@devsync/schemas";
import { useId, useState } from "react";
import styles from "./devsync.module.css";
import { Field, memberName, Problem } from "./parts";
import { useDevSync } from "./provider";
import { useMembers, useWorkspaceTasks } from "./queries";

export interface WorkspacePageProps {
  /** The host's path to a task on its project's DevSync tab (`?task=<id>`). */
  taskHref: (projectId: string, taskId: string) => string;
}

/** The workspace's DevSync page: the open tasks of every project with DevSync on, filterable. */
export function WorkspacePage({ taskHref }: WorkspacePageProps) {
  const { ui } = useDevSync();
  const { Icon, EmptyState, Link } = ui;
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<TaskStatus | "">("");
  const [mine, setMine] = useState(false);
  const heading = useId();
  const filtered = project !== "" || status !== "" || mine;
  // The open tasks name the projects to filter by; the filtered list adds those with only closed ones.
  const open = useWorkspaceTasks({});
  const tasks = useWorkspaceTasks({ project, status: status || undefined, mine });
  const members = useMembers().data?.members;

  const projects = new Map<string, string>();
  for (const task of [...open.tasks, ...tasks.tasks]) {
    projects.set(task.projectId, task.projectName);
  }
  const list = tasks.tasks;

  return (
    <section className="card bordered" aria-labelledby={heading}>
      <div className="card-h">
        <h3 className="card-t" id={heading}>
          <Icon name="kanban" />
          {status ? `${STATUS_LABEL[status]} tasks` : "Open tasks"}
        </h3>
        <span className="chip">{`${list.length}${tasks.hasNextPage ? "+" : ""}`}</span>
      </div>
      <div className={styles.filters}>
        <Field label="Project">
          <select
            className="field"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">All projects</option>
            {[...projects].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className="field"
            value={status}
            onChange={(event) => {
              const value = TaskStatus.safeParse(event.target.value);
              setStatus(value.success ? value.data : "");
            }}
          >
            <option value="">Open</option>
            {TaskStatus.options.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </Field>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={mine}
            onChange={(event) => setMine(event.target.checked)}
          />
          Assigned to me
        </label>
      </div>
      <Problem error={tasks.error} />
      {tasks.isSuccess && list.length === 0 && (
        <EmptyState icon="check-circle" title={filtered ? "No tasks match" : "No open tasks"}>
          {filtered
            ? "Change the filters to see more."
            : "Create tasks on a project's DevSync tab; every project's open ones show here."}
        </EmptyState>
      )}
      {list.length > 0 && (
        <ul className={styles.rows}>
          {list.map((task) => (
            <li key={task.id}>
              <Link className={styles.row} to={taskHref(task.projectId, task.id)}>
                <span className="cream">{task.title}</span>
                <span className="sub">
                  {[
                    task.projectName,
                    STATUS_LABEL[task.status],
                    task.assigneeUserId ? memberName(members, task.assigneeUserId) : "Unassigned",
                  ].join(" · ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {tasks.hasNextPage && (
        <div className={styles.buttons}>
          <button
            className="btn btn-sm btn-secondary bordered"
            type="button"
            disabled={tasks.isFetchingNextPage}
            onClick={() => tasks.fetchNextPage()}
          >
            Show more tasks
          </button>
        </div>
      )}
    </section>
  );
}

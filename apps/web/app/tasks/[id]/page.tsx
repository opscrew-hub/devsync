import { auth } from "@/auth";
import { DomainError, getTask, requireProject } from "@devsync/core";
import { listTaskActivity } from "@devsync/core/task-activity";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CommentForm } from "./comment-form";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ project?: string }> };
const formatDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export default async function TaskPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.userId) redirect("/");
  const { project } = await searchParams;
  if (typeof project !== "string") notFound();
  const { id } = await params;
  const [task, membership, reports] = await Promise.all([getTask(session.userId, project, id), requireProject(session.userId, project), listTaskActivity(session.userId, project, id)]).catch((error: unknown) => {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  });
  const activity = [
    ...reports.map(report => ({ kind: "report" as const, date: report.createdAt, report })),
    ...task.revisions.map(revision => ({ kind: "revision" as const, date: revision.createdAt, revision })),
    ...task.comments.map(comment => ({ kind: "comment" as const, date: comment.createdAt, comment })),
  ].sort((left, right) => right.date.getTime() - left.date.getTime());
  return <main className="content task-detail">
    <Link href={`/?project=${project}`} className="detail-link">← {membership.project.name}</Link>
    <div className="heading"><h1>{task.title}</h1><span className="badge">{task.status.toLowerCase().replaceAll("_", " ")}</span></div>
    <section className="panel task-summary">
      <h2>Description</h2><p>{task.description || "No description."}</p>
      <h2>Acceptance criteria</h2><p>{task.acceptanceCriteria || "No acceptance criteria."}</p>
    </section>
    <h2>Activity</h2>
    {membership.role !== "VIEWER" && <CommentForm taskId={id} projectId={project}/>}
    <ol className="timeline">
      {activity.map(entry => {
        const date = <time dateTime={entry.date.toISOString()}>{formatDate.format(entry.date)} UTC</time>;
        if (entry.kind === "report") {
          return <li className="panel" key={entry.report.id}>
            <strong>{entry.report.label}{entry.report.agentName && " · " + entry.report.agentName}</strong>
            {date}<p>{entry.report.message}</p>
          </li>;
        }
        return entry.kind === "revision"
          ? <li className="panel" key={`revision-${entry.revision.number}`}><details><summary>Requirements revision {entry.revision.number}</summary><p>{entry.revision.title}</p><p>{entry.revision.description}</p><p>{entry.revision.acceptanceCriteria}</p></details>{date}</li>
          : <li className="panel" key={entry.comment.id}><strong>{entry.comment.author.name}</strong>{date}<p>{entry.comment.body}</p></li>;
      })}
    </ol>
  </main>;
}

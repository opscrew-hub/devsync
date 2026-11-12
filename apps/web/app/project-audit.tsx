type Entry = {
  id: string;
  action: string;
  targetId: string;
  createdAt: Date;
  actor: { name: string };
  details: unknown;
};

const labels: Record<string, string> = {
  "project.created": "Project created",
  "member.access_changed": "Project access changed",
  "agent.registered": "Agent registered",
  "agent.credential_rotated": "Agent credential rotated",
  "agent.credential_revoked": "Agent credential revoked",
};
const formatDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function ProjectAudit({ entries }: { entries: Entry[] }) {
  return <section className="project-members">
    <h2>Project audit log</h2>
    {entries.length === 0 ? <p>No administrative changes recorded.</p> : <ol className="timeline">
      {entries.map(entry => <li className="panel" key={entry.id}>
        <strong>{labels[entry.action] ?? entry.action}</strong>
        <span>{entry.actor.name} · {entry.details && typeof entry.details === "object" && "name" in entry.details && typeof entry.details.name === "string" ? entry.details.name : <code>{entry.targetId}</code>}</span>
        {entry.details !== null && typeof entry.details === "object" && "previousRole" in entry.details &&
          "role" in entry.details && <p>{String(entry.details.previousRole ?? "No access")} → {String(entry.details.role ?? "No access")}</p>}
        <time dateTime={entry.createdAt.toISOString()}>{formatDate.format(entry.createdAt)} UTC</time>
      </li>)}
    </ol>}
  </section>;
}

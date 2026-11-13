"use client";

import { githubSnapshot } from "@devsync/contracts";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Repository = { installationId: string; repositoryId: string; fullName: string; snapshot?: unknown };

export function GithubPanel({ projectId, repository, activity, state, health, owner }: {
  health: { pending: number; lastReceived: Date | null; lastProcessed: Date | null; oldestPending: Date | null } | null;
  state: { event: string; key: string; label: string | null; state: string }[];
  projectId: string; repository: Repository | null; activity: { deliveryId: string; event: string; action: string | null; subject: string | null; receivedAt: Date }[]; owner: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/github`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId: Number(data.get("installationId")), repositoryId: Number(data.get("repositoryId")) }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Repository verification failed.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Repository verification failed.");
    } finally {
      setBusy(false);
    }
  }

  const snapshot = githubSnapshot.safeParse(repository?.snapshot).data;
  return <section className="project-members">
    <h2>GitHub repository</h2>
    <p>{repository ? `Linked repository: ${repository.fullName}` : "No repository linked."}</p>
    {health && <form action={async () => {
      setBusy(true);
      setError("");
      try {
        const result = await fetch("/api/v1/projects/" + projectId + "/github/snapshot", { method: "POST" });
        if (!result.ok) throw new Error((await result.json()).error ?? "Refresh failed.");
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Refresh failed.");
      } finally {
        setBusy(false);
      }
    }}><button disabled={busy}>Refresh GitHub snapshot</button></form>}
    {snapshot && <section className="panel task-summary">
      <h3>GitHub API snapshot</h3><small>Fetched {snapshot.fetchedAt}</small>
      <h4>Branches</h4><ul>{snapshot.branches.map(item => <li key={item.name}>{item.name} · {item.commit.sha.slice(0, 12)}</li>)}</ul>
      <h4>Pull requests</h4><ul>{snapshot.pulls.map(item => <li key={item.number}>#{item.number} {item.title} · {item.state}</li>)}</ul>
      <h4>Default branch checks</h4><ul>{snapshot.checks.map(item => <li key={item.id}>{item.name} · {item.conclusion ?? item.status}</li>)}</ul>
    </section>}
    {health && <section className="panel task-summary">
      <h3>Webhook delivery</h3>
      <p>{health.pending} pending</p>
      <p>Last received {health.lastReceived?.toISOString() ?? "—"}</p>
      <p>Last processed {health.lastProcessed?.toISOString() ?? "—"}</p>
      {health.oldestPending && <p>Oldest pending {health.oldestPending.toISOString()}</p>}
    </section>}
    {repository && <>
      {([["push", "Branches"], ["pull_request", "Pull requests"], ["check_run", "Checks"]] as const).map(([event, label]) => {
        const items = state.filter(item => item.event === event);
        const snapshot = githubSnapshot.safeParse(repository?.snapshot).data;
  return <section key={event}><h3>{label}</h3>
          {items.length ? <ul className="panel list">{items.map(item => <li key={item.key}>
            <strong>{event === "push" ? item.key : item.label ?? item.key}</strong>
            <code>{event === "push" ? item.label?.slice(0, 12) : item.state}</code>
          </li>)}</ul> : <p>No webhook state observed yet.</p>}
        </section>;
      })}
      <h3>Recent GitHub activity</h3>
      {activity.length ? <ol className="timeline">{activity.map(item => <li className="panel" key={item.deliveryId}>
        <strong>{item.event.replaceAll("_", " ")}{item.action && " · " + item.action}</strong>
        {item.subject && <p>{item.subject}</p>}
        <time dateTime={item.receivedAt.toISOString()}>{item.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time>
      </li>)}</ol> : <p>No processed deliveries yet.</p>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {owner && <form className="editor panel" onSubmit={link}>
      <label>Installation ID<input name="installationId" inputMode="numeric" pattern="[0-9]+" defaultValue={repository?.installationId} required/></label>
      <label>Repository ID<input name="repositoryId" inputMode="numeric" pattern="[0-9]+" defaultValue={repository?.repositoryId} required/></label>

      <button className="primary" disabled={busy}>{busy ? "Verifying…" : "Verify and link repository"}</button>
    </form>}
  </section>;
}

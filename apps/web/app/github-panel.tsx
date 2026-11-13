"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Repository = { installationId: string; repositoryId: string; fullName: string };

export function GithubPanel({ projectId, repository, activity, owner }: {
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

  return <section className="project-members">
    <h2>GitHub repository</h2>
    <p>{repository ? `Linked repository: ${repository.fullName}` : "No repository linked."}</p>
    {repository && <><h3>Recent GitHub activity</h3>
      {activity.length ? <ol className="timeline">{activity.map(item => <li className="panel" key={item.deliveryId}>
        <strong>{item.event.replaceAll("_", " ")}{item.action && " · " + item.action}</strong>
        {item.subject && <p>{item.subject}</p>}
        <time dateTime={item.receivedAt.toISOString()}>{item.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time>
      </li>)}</ol> : <p>No processed deliveries yet.</p>}
    </>}
    {owner && <form className="editor panel" onSubmit={link}>
      <label>Installation ID<input name="installationId" inputMode="numeric" pattern="[0-9]+" defaultValue={repository?.installationId} required/></label>
      <label>Repository ID<input name="repositoryId" inputMode="numeric" pattern="[0-9]+" defaultValue={repository?.repositoryId} required/></label>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Verifying…" : "Verify and link repository"}</button>
    </form>}
  </section>;
}

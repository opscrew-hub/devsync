"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const formatTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export function RunsPanel({ projectId, taskId, ready, writer, admin, runs }: {
  projectId: string; taskId: string; ready: boolean; writer: boolean; admin: boolean;
  runs: { id: string; revision: number; agentType: string; status: string; changes: unknown; hasPatch: boolean; baseCommit: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(body: object, id?: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/runs${id ? "/" + id : ""}?projectId=${projectId}`, {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Run update failed.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run update failed.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel task-summary">
    <h2>Managed runs</h2>
    <p>Approved runs are queued. Execution is pending worker integration.</p>
    {writer && ready && !runs.some(run => ["REQUESTED", "QUEUED", "RUNNING"].includes(run.status)) &&
      <form className="actions" action={data => save({ taskId, agentType: data.get("agentType") })}>
        <label>Agent<select name="agentType"><option>CODEX</option><option>CLAUDE</option></select></label>
        <button disabled={busy}>Request run</button>
      </form>}
    {error && <p role="alert">{error}</p>}
    <ul className="list">{runs.map(run => <li key={run.id}>
      <strong>{run.agentType}</strong> · Revision {run.revision} · {run.status.toLowerCase()}
      <dl>
        {([["Requested", run.createdAt], ["Started", run.startedAt], ["Finished", run.finishedAt]] as const).map(([label, date]) =>
          date && <div key={label}><dt>{label}</dt><dd><time dateTime={date.toISOString()}>{formatTime.format(date)}</time></dd></div>
        )}
      </dl>
      {run.baseCommit && <p>Base commit <code>{run.baseCommit}</code></p>}
      {run.hasPatch && <a className="detail-link" href={`/api/v1/runs/${encodeURIComponent(run.id)}/patch?projectId=${encodeURIComponent(projectId)}&download=1`}>Download patch</a>}
      {Array.isArray(run.changes) && <details>
        <summary>{run.changes.length} changed files</summary>
        <ul>{run.changes.map((change, index) => change && typeof change.path === "string" && typeof change.status === "string" &&
          <li key={index}><code>{change.status} {change.path}</code></li>)}</ul>
      </details>}
      {admin && run.status === "REQUESTED" && <div className="actions">
        <button disabled={busy} onClick={() => save({ status: "QUEUED" }, run.id)}>Approve</button>
        <button disabled={busy} onClick={() => save({ status: "REJECTED" }, run.id)}>Reject</button>
      </div>}
      {admin && ["REQUESTED", "QUEUED", "RUNNING"].includes(run.status) &&
        <button disabled={busy} onClick={() => save({ status: "CANCELLED" }, run.id)}>Cancel</button>}
    </li>)}</ul>
  </section>;
}

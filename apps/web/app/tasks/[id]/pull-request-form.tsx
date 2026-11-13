"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function PullRequestForm({ projectId, taskId, current }: {
  projectId: string; taskId: string; current: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("number");
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/pull-request?projectId=${projectId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: value ? Number(value) : null }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not save the link.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the link.");
    } finally {
      setBusy(false);
    }
  }
  return <form className="editor panel" onSubmit={save}>
    <label>Pull request number<input name="number" inputMode="numeric" pattern="[1-9][0-9]*" defaultValue={current ?? ""}/></label>
    <small>Enter a pull request observed by DevSync. Leave blank to remove the link.</small>
    {error && <p role="alert" className="error">{error}</p>}
    <button disabled={busy}>{busy ? "Saving…" : "Save pull request link"}</button>
  </form>;
}

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function CommentForm({ taskId, projectId }: { taskId: string; projectId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/comments?projectId=${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: new FormData(form).get("body") }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? "Could not post the comment.");
      }
      form.reset();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not post the comment.");
    } finally {
      setPending(false);
    }
  }

  return <form className="editor panel" onSubmit={submit}>
    <label>Add a comment<textarea name="body" rows={4} maxLength={4000} required disabled={pending}/></label>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions"><button className="primary" disabled={pending}>{pending ? "Posting…" : "Post comment"}</button></div>
  </form>;
}

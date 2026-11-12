"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function MemberForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/members`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: values.get("userId"), role: values.get("role") || null }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not update membership.");
      form.reset();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update membership.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="editor panel" onSubmit={save}>
    <label>DevSync account ID<input name="userId" placeholder="github:123456" required maxLength={40}/></label>
    <label>Project access<select name="role" defaultValue="DEVELOPER">
      <option value="DEVELOPER">Developer</option>
      <option value="ADMIN">Admin</option>
      <option value="VIEWER">Viewer</option>
      <option value="">Remove access</option>
    </select></label>
    {error && <p role="alert" className="error">{error}</p>}
    <button className="primary" disabled={busy}>{busy ? "Saving…" : "Update access"}</button>
  </form>;
}

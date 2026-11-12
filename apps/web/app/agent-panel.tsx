"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Agent = { id: string; name: string; type: string; status: string };
type Signal = { id: string; kind: string; acknowledged: boolean; recipientId: string; sender: string; message: string };

export function AgentPanel({ projectId, agents, signals, owner, writer }: {
  projectId: string; agents: Agent[]; signals: Signal[]; owner: boolean; writer: boolean;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>, mode: "register" | "signal" | "revoke" | "rotate") {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const query = new URLSearchParams({ projectId });
    if (mode === "revoke" || mode === "rotate") query.set("agentId", String(values.agentId));
    const body = mode === "signal"
      ? { recipientId: values.recipientId, kind: values.kind, payload: { message: values.message }, idempotencyKey: values.idempotencyKey }
      : values;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/v1/${mode === "signal" ? "signals" : "agents"}?${query}`, {
        method: mode === "revoke" ? "DELETE" : mode === "rotate" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: mode === "revoke" ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (mode === "register" || mode === "rotate") setToken(result.data.token);
      form.reset();
      setNotice(mode === "signal" ? "Signal queued." : mode === "revoke" ? "Credential revoked." : mode === "rotate" ? "Credential rotated." : "Agent registered.");
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  const available = agents.filter(agent => agent.status !== "Revoked" && agent.status !== "Expired");
  return <section className="project-members">
    <h2>Agents</h2>
    {agents.length ? <ul className="panel list">{agents.map(agent => <li key={agent.id}>
      <strong>{agent.name}</strong><span>{agent.type}</span><span className="badge">{agent.status}</span>
      {owner && <form onSubmit={event => submit(event, "rotate")}>
        <input type="hidden" name="agentId" value={agent.id}/><button disabled={busy}>Rotate credential</button>
      </form>}
      {owner && agent.status !== "Revoked" && <form onSubmit={event => submit(event, "revoke")}>
        <input type="hidden" name="agentId" value={agent.id}/><button disabled={busy}>Revoke credential</button>
      </form>}
    </li>)}</ul> : <p>No agents registered.</p>}
    {owner && <form className="editor panel" onSubmit={event => submit(event, "register")}>
      <label>Agent name<input name="name" required maxLength={80}/></label>
      <label>Agent type<select name="type"><option>CODEX</option><option>CLAUDE</option></select></label>
      <button className="primary" disabled={busy}>Register agent</button>
    </form>}
    {token && <div className="editor panel"><label>Copy this credential now. It expires in 24 hours.
      <input value={token} readOnly onFocus={event => event.currentTarget.select()}/></label><button onClick={() => setToken("")}>Hide credential</button></div>}
    <h2>Signals</h2>
    {signals.length ? <ul className="panel list">{signals.map(signal => <li key={signal.id}>
      <strong>{signal.kind}</strong><span>{signal.sender} → {agents.find(agent => agent.id === signal.recipientId)?.name}</span>
      <span className="badge">{signal.acknowledged ? "Acknowledged" : "Pending"}</span><p>{signal.message}</p>
    </li>)}</ul> : <p>No signals sent.</p>}
    {writer && available.length > 0 && <form className="editor panel" onSubmit={event => {
      const key = event.currentTarget.querySelector<HTMLInputElement>("[name=idempotencyKey]");
      if (key && !key.value) key.value = crypto.randomUUID();
      return submit(event, "signal");
    }}>
      <input type="hidden" name="idempotencyKey" defaultValue=""/>
      <label>Recipient<select name="recipientId">{available.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label>Signal type<select name="kind">
        <option>clarification.requested</option><option>clarification.answered</option><option>review.requested</option><option>system.warning</option>
      </select></label>
      <label>Message<textarea name="message" required maxLength={4000}/></label>
      <button className="primary" disabled={busy}>Send signal</button>
    </form>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

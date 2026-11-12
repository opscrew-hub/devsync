"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { statuses } from "@devsync/contracts";
import { Plus } from "lucide-react";

type Task = { id: string; title: string; description: string; acceptanceCriteria: string; status: string; version: number; revision: number };
const display = (status: string) => status.toLowerCase().replaceAll("_", " ");

export function Workspace({ project, tasks }: { project?: { id: string; name: string; description: string }; tasks: Task[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("list");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<Task | "new" | "project" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = typeof editing === "object" ? editing : null;
  const filtered = tasks.filter(task => (!status || task.status === status) && task.title.toLowerCase().includes(search.toLowerCase()));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const endpoint = editing === "project" ? "/api/v1/projects" : `/api/v1/tasks${current ? "/" + current.id : ""}?projectId=${project?.id}`;
    try {
      const response = await fetch(endpoint, { method: current ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current ? { ...values, version: current.version } : values) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Save failed.");
      if (editing === "project") router.push(`/?project=${result.data.id}`);
      setEditing(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  function open(value: typeof editing) { setError(""); setEditing(value); }
  const row = (task: Task) => <button key={task.id} className="task" onClick={() => open(task)}><span>{task.title}</span><span className="badge">{display(task.status)}</span></button>;
  return <>
    <div className="heading"><div><h1>{project?.name ?? "Projects"}</h1>{project?.description && <p>{project.description}</p>}</div><button onClick={() => open("project")}><Plus size={15}/> New project</button></div>
    {editing && <form className="editor panel" key={current?.id ?? String(editing)} onSubmit={save}>
      <h2>{current ? "Edit task" : editing === "project" ? "New project" : "New task"}</h2>
      <label>{editing === "project" ? "Project name" : "Title"}<input name={editing === "project" ? "name" : "title"} defaultValue={current?.title} required maxLength={editing === "project" ? 100 : 160}/></label>
      <label>Description<textarea name="description" defaultValue={current?.description} maxLength={editing === "project" ? 2000 : 8000}/></label>
      {editing !== "project" && <label>Acceptance criteria<textarea name="acceptanceCriteria" defaultValue={current?.acceptanceCriteria} maxLength={8000}/></label>}
      {current && <label>Status<select name="status" defaultValue={current.status}>{statuses.filter(value => value !== "CLAIMED" || value === current.status).map(value => <option key={value} value={value}>{display(value)}</option>)}</select><small>Requirements revision {current.revision}</small></label>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button type="button" onClick={() => open(null)} disabled={busy}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
    </form>}
    {!project ? <div className="empty panel"><h2>Create your first project</h2><p>Give your team a place to track tasks and requirements.</p></div> : <>
      <div className="metrics">{[["Total tasks", tasks.length], ["In progress", tasks.filter(task => ["CLAIMED", "IN_PROGRESS"].includes(task.status)).length], ["Blocked", tasks.filter(task => task.status === "BLOCKED").length], ["In review", tasks.filter(task => task.status === "REVIEW").length]].map(([label, count]) => <div className="panel metric" key={label}><span>{label}</span><strong>{count}</strong></div>)}</div>
      <div className="heading"><h2>Tasks</h2><button className="primary" onClick={() => open("new")}><Plus size={15}/> New task</button></div>
      <div className="filters"><input aria-label="Search tasks" placeholder="Search tasks" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{display(value)}</option>)}</select><button aria-pressed={mode === "board"} onClick={() => setMode(mode === "board" ? "list" : "board")}>{mode === "board" ? "Show list" : "Show board"}</button></div>
      {filtered.length === 0 ? <div className="empty panel">{tasks.length ? "No tasks match your filters." : "No tasks yet. Create a task to get started."}</div> : mode === "board" ? <div className="board">{statuses.filter(value => !status || value === status).map(value => <section className="panel column" key={value}><h3>{display(value)}</h3>{filtered.filter(task => task.status === value).map(row)}</section>)}</div> : <div className="panel list">{filtered.map(row)}</div>}
    </>}
  </>;
}

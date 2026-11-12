import { auth, signIn, signOut } from "@/auth";
import { listProjectMembers, listProjects, listTasks } from "@devsync/core";
import { GitBranch, Github, LayoutGrid } from "lucide-react";
import { listAgents, listSignals } from "@devsync/core/agent-signals";
import { AgentPanel } from "./agent-panel";
import { MemberForm } from "./member-form";
import { Workspace } from "./workspace";
import Link from "next/link";
export default async function Page({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const session = await auth();
  if (!session?.userId) return <main className="login"><div className="login-card">
    <div className="brand"><span className="mark"><GitBranch size={19}/></span>DevSync</div>
    <h1>Sign in to DevSync</h1>
    <p>Manage projects, tasks, and requirements in one shared workspace.</p>
    <form action={async () => { "use server"; await signIn("github", { redirectTo: "/" }); }}>
      <button className="primary"><Github size={16}/> Continue with GitHub</button>
    </form>
  </div></main>;
  const projects = await listProjects(session.userId);
  const requested = (await searchParams).project;
  const active = projects.find(project => project.id === requested) ?? projects[0];
  const [tasks, members, agents, signals] = active
    ? await Promise.all([listTasks(session.userId, active.id), listProjectMembers(session.userId, active.id), listAgents(session.userId, active.id), listSignals(session.userId, active.id)])
    : [[], [], [], []];
  const role = members.find(member => member.userId === session.userId)?.role;
  return <div className="shell">
    <aside><div className="brand"><span className="mark"><GitBranch size={17}/></span>DevSync</div>
      <div className="nav-heading"><LayoutGrid size={15}/> Projects</div>
      <nav aria-label="Projects">{projects.map(project => <Link aria-current={active?.id === project.id ? "page" : undefined} key={project.id} href={`/?project=${project.id}`}>{project.name}</Link>)}</nav>
    </aside>
    <div className="main"><header><span>Workspace <span className="slash">/</span> {active?.name ?? "Projects"}</span>
      <div><details><summary>Account</summary><p>DevSync account ID <code>{session.userId}</code></p></details><form action={async () => { "use server"; await signOut({ redirectTo: "/" }); }}><button>Sign out</button></form></div>
    </header>
    <main className="content"><Workspace key={active?.id ?? "empty"} project={active} tasks={tasks} members={members} canEdit={role !== undefined && role !== "VIEWER"}/>
      {active && <section className="project-members">
        <h2>Project members</h2>
        <ul className="panel list">{members.map(member => <li key={member.userId}>{member.user.name} <span className="badge">{member.role.toLowerCase()}</span> <code>{member.userId}</code></li>)}</ul>
        {role === "OWNER" && <MemberForm projectId={active.id}/>}
      </section>}
      {active && <AgentPanel key={active.id} projectId={active.id} owner={role === "OWNER"} writer={role !== undefined && role !== "VIEWER"}
        agents={agents}
        signals={signals.map(signal => ({ id: signal.id, kind: signal.kind, recipientId: signal.recipientId, acknowledged: !!signal.acknowledgedAt }))}
      />}
    </main></div>
  </div>;
}

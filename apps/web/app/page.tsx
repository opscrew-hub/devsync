import { auth, signIn, signOut } from "@/auth";
import { listProjects, listTasks } from "@devsync/core";
import { GitBranch, Github, LayoutGrid } from "lucide-react";
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
  const tasks = active ? await listTasks(session.userId, active.id) : [];
  return <div className="shell">
    <aside><div className="brand"><span className="mark"><GitBranch size={17}/></span>DevSync</div>
      <div className="nav-heading"><LayoutGrid size={15}/> Projects</div>
      <nav aria-label="Projects">{projects.map(project => <Link aria-current={active?.id === project.id ? "page" : undefined} key={project.id} href={`/?project=${project.id}`}>{project.name}</Link>)}</nav>
    </aside>
    <div className="main"><header><span>Workspace <span className="slash">/</span> {active?.name ?? "Projects"}</span>
      <form action={async () => { "use server"; await signOut({ redirectTo: "/" }); }}><button>Sign out</button></form>
    </header>
    <main className="content"><Workspace key={active?.id ?? "empty"} project={active} tasks={tasks}/></main></div>
  </div>;
}

import type { WorkspaceTask } from "@devsync/schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModuleProjectTabProps, type ModuleWorkspacePageProps, webModule } from "./module";
import { fakeFetch, id, ME, type Reply } from "./test/render";
import { agent, detail, members, PROJECT, pullRequests, task, tasks } from "./test/samples";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The host's UI pieces as the contract types them: any icon name the dashboard's sprite has. */
interface HostUi {
  Icon: ComponentType<{ name: string; className?: string }>;
  Dialog: ComponentType<{
    title: string;
    icon: string;
    onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
    children: ReactNode;
  }>;
  EmptyState: ComponentType<{
    icon: string;
    title: string;
    children: ReactNode;
    action?: ReactNode;
  }>;
  Link: ComponentType<{ to: string; className?: string; children: ReactNode }>;
}

const ui: HostUi = {
  Icon: ({ name, className }) => <svg className={className} data-icon={name} aria-hidden />,
  Dialog: ({ title, onSubmit, children }) =>
    onSubmit ? (
      <form role="dialog" aria-label={title} onSubmit={onSubmit}>
        {children}
      </form>
    ) : (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ),
  EmptyState: ({ title, children, action }) => (
    <div>
      <p>{title}</p>
      <p>{children}</p>
      {action}
    </div>
  ),
  Link: ({ to, className, children }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
};

const PROJECT_API = `/api/w/ws1/projects/${PROJECT}/m/devsync`;
const WORKSPACE_API = "/api/w/ws1/m/devsync";

/** Renders `element` as the host does, inside its QueryClientProvider, with `fetch` faked. */
function host(element: ReactNode, apiBase: string, routes: Record<string, Reply>) {
  const fake = fakeFetch(routes, apiBase);
  vi.stubGlobal("fetch", fake.fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return fake;
}

function projectTab(query: string) {
  const setQuery = vi.fn<ModuleProjectTabProps["setQuery"]>();
  const props: ModuleProjectTabProps = {
    apiBase: PROJECT_API,
    userId: ME,
    role: "developer",
    ui,
    project: { id: PROJECT, fullName: "acme/shop", readOnly: false },
    query: new URLSearchParams(query),
    setQuery,
  };
  const fake = host(<webModule.ProjectTab {...props} />, PROJECT_API, {
    "GET /tasks": { body: { tasks } },
    "GET /members": { body: { members } },
    "GET /agents": { body: { agents: [agent] } },
    "GET /pull-requests": { body: { pullRequests } },
    [`GET /tasks/${detail.id}`]: { body: detail },
  });
  return { ...fake, setQuery };
}

describe("webModule.ProjectTab", () => {
  it("lists the project's tasks from apiBase and opens one through setQuery", async () => {
    const { sent, setQuery } = projectTab("");
    await userEvent.click(await screen.findByRole("button", { name: /Add the sign-up form/ }));
    expect(setQuery).toHaveBeenCalledWith({ task: detail.id });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toContain("GET /tasks");
    expect(screen.queryByRole("region", { name: "Add the sign-up form" })).toBeNull();
  });

  it("opens the task the query's ?task= names, and closing it removes it", async () => {
    const { setQuery } = projectTab(`task=${detail.id}`);
    const panel = await screen.findByRole("region", { name: "Add the sign-up form" });
    await within(panel).findByText("Description");
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(setQuery).toHaveBeenCalledWith({ task: null });
  });

  it("gives the member's role to DevSync: a developer can't register agents", async () => {
    projectTab("");
    expect(
      (await screen.findByRole("button", { name: /Register an agent/ })).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("webModule.WorkspacePage", () => {
  it("links each task to its project's tab with projectHref", async () => {
    const WorkspacePage = webModule.WorkspacePage;
    const blog = id(51);
    const open: WorkspaceTask[] = [
      { ...task(10, { title: "Add the sign-up form", status: "READY" }), projectName: "shop" },
      { ...task(60, { title: "Write the first post", projectId: blog }), projectName: "blog" },
    ];
    const projectHref = vi.fn<ModuleWorkspacePageProps["projectHref"]>(
      (projectId, query) => `/w/ws1/projects/${projectId}/m/devsync?${new URLSearchParams(query)}`,
    );
    const props: ModuleWorkspacePageProps = {
      apiBase: WORKSPACE_API,
      userId: ME,
      role: "owner",
      ui,
      projectHref,
    };
    host(<WorkspacePage {...props} />, WORKSPACE_API, {
      "GET /tasks": { body: { tasks: open } },
      "GET /members": { body: { members } },
    });

    const link = await screen.findByRole("link", { name: /Add the sign-up form/ });
    expect(link.getAttribute("href")).toBe(`/w/ws1/projects/${PROJECT}/m/devsync?task=${id(10)}`);
    expect(screen.getByRole("link", { name: /Write the first post/ }).getAttribute("href")).toBe(
      `/w/ws1/projects/${blog}/m/devsync?task=${id(60)}`,
    );
    expect(projectHref).toHaveBeenCalledWith(blog, { task: id(60) });
  });
});

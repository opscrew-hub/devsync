import type { WorkspaceTask } from "@devsync/schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModuleProjectTabProps, type ModuleWorkspacePageProps, webModule } from "./module";
import { fakeFetch, id, ME, type Reply } from "./test/render";
import {
  agent,
  detail,
  finding,
  members,
  PROJECT,
  pullRequests,
  setupComplete,
  setupMissing,
  task,
  tasks,
} from "./test/samples";

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

function projectTab(query: string, readOnly = false, routes: Record<string, Reply> = {}) {
  const setQuery = vi.fn<ModuleProjectTabProps["setQuery"]>();
  const props: ModuleProjectTabProps = {
    apiBase: PROJECT_API,
    userId: ME,
    role: "developer",
    ui,
    project: { id: PROJECT, fullName: "acme/shop", defaultBranch: "release/2.x", readOnly },
    query: new URLSearchParams(query),
    setQuery,
  };
  const fake = host(<webModule.ProjectTab {...props} />, PROJECT_API, {
    "GET /tasks": { body: { tasks } },
    "GET /members": { body: { members } },
    "GET /agents": { body: { agents: [agent] } },
    "GET /pull-requests": { body: { pullRequests } },
    [`GET /tasks/${detail.id}`]: { body: detail },
    [`GET /tasks/${detail.id}/runs`]: { body: { runs: [] } },
    "GET /runs/setup": { body: setupComplete },
    ...routes,
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

  it("makes a task from the query's ?finding=, then opens it and clears the finding", async () => {
    const found = finding();
    const created = task(16, { title: `Fix: ${found.title}` });
    const { setQuery } = projectTab(`finding=${encodeURIComponent(found.fingerprint)}`, false, {
      "GET /findings": { body: { finding: found, task: null } },
      "POST /tasks": { status: 201, body: created },
    });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create the task" }));
    await waitFor(() => expect(setQuery).toHaveBeenCalledWith({ task: created.id, finding: null }));
  });

  it("opens the finding's linked task, and closing the dialog keeps the open task", async () => {
    const found = finding();
    const linked = task(17);
    const { setQuery } = projectTab(`finding=${found.fingerprint}`, false, {
      "GET /findings": { body: { finding: found, task: linked } },
    });
    await waitFor(() => expect(setQuery).toHaveBeenCalledWith({ task: linked.id, finding: null }));
    cleanup();

    const closing = projectTab(`task=${detail.id}&finding=${found.fingerprint}`, false, {
      "GET /findings": { body: { finding: found, task: null } },
    });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(closing.setQuery).toHaveBeenCalledWith({ task: detail.id, finding: null });
  });

  it("links the runs section's setup to the project's repository on GitHub", async () => {
    projectTab(`task=${detail.id}`, false, { "GET /runs/setup": { body: setupMissing } });
    const runs = await screen.findByRole("region", { name: "Managed runs" });
    const create = await within(runs).findByRole("link", { name: "Create it on GitHub" });
    expect(create.getAttribute("href")).toBe(
      "https://github.com/acme/shop/new/release/2.x?filename=.github/workflows/devsync.yml",
    );
    expect(
      within(runs).getByRole("link", { name: "Add a key on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/acme/shop/settings/secrets/actions");
  });

  it("points every role to the host's Agents button, and registers no agent itself", async () => {
    for (const role of ["owner", "admin", "approver", "developer"] as const) {
      host(
        <webModule.ProjectTab
          apiBase={PROJECT_API}
          userId={ME}
          role={role}
          ui={ui}
          project={{ id: PROJECT, fullName: "acme/shop", defaultBranch: "main", readOnly: false }}
          query={new URLSearchParams()}
          setQuery={() => {}}
        />,
        PROJECT_API,
        {
          "GET /tasks": { body: { tasks } },
          "GET /members": { body: { members } },
          "GET /agents": { body: { agents: [agent] } },
        },
      );
      const agents = await screen.findByRole("region", { name: "Agents" });
      expect(
        within(agents).getByText(/from the Agents button at the top of this project's page\.$/),
      ).toBeTruthy();
      expect(within(agents).queryByRole("button", { name: /Register/ })).toBeNull();
      cleanup();
    }
  });

  it("locks every change on a read-only project", async () => {
    projectTab(`task=${detail.id}`, true);
    const panel = await screen.findByRole("region", { name: "Add the sign-up form" });
    expect((await screen.findByRole("button", { name: /New task/ })).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      within(panel).getByRole("button", { name: "Edit the requirements" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(panel).getByRole("button", { name: "Ask for a run" }).hasAttribute("disabled"),
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

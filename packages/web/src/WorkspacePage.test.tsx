import type { WorkspaceTask } from "@devsync/schemas";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { id, ME, renderWith } from "./test/render";
import { members, PROJECT, task } from "./test/samples";
import { WorkspacePage } from "./WorkspacePage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const WS = "/api/w/ws1/m/devsync";
const BLOG = id(51);
const open: WorkspaceTask[] = [
  {
    ...task(10, { title: "Add the sign-up form", status: "READY", assigneeUserId: ME }),
    projectName: "shop",
  },
  { ...task(60, { title: "Write the first post", projectId: BLOG }), projectName: "blog" },
];
const done: WorkspaceTask = {
  ...task(61, { title: "Pick a theme", projectId: BLOG, status: "DONE" }),
  projectName: "blog",
};
const taskHref = (projectId: string, taskId: string) =>
  `/w/ws1/projects/${projectId}/devsync?task=${taskId}`;

function show() {
  return renderWith(<WorkspacePage taskHref={taskHref} />, {
    apiBase: WS,
    routes: {
      "GET /tasks": { body: { tasks: open } },
      [`GET /tasks?project=${BLOG}`]: { body: { tasks: open.slice(1) } },
      "GET /tasks?status=DONE": { body: { tasks: [done] } },
      "GET /tasks?assignee=me": { body: { tasks: open.slice(0, 1) } },
      "GET /members": { body: { members } },
    },
  });
}

describe("WorkspacePage", () => {
  it("lists the open tasks across projects, each linking to its project's tab", async () => {
    show();
    const link = await screen.findByRole("link", { name: /Add the sign-up form/ });
    expect(link.getAttribute("href")).toBe(`/w/ws1/projects/${PROJECT}/devsync?task=${id(10)}`);
    expect(link.textContent).toContain("shop · Ready · Ana Lima");
    expect(screen.getByRole("link", { name: /Write the first post/ }).textContent).toContain(
      "blog · Backlog · Unassigned",
    );
  });

  it("filters by project, status and assigned to me", async () => {
    const { sent } = show();
    await screen.findByRole("link", { name: /Add the sign-up form/ });
    const project = screen.getByLabelText("Project");
    expect(
      within(project)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All projects", "shop", "blog"]);

    await userEvent.selectOptions(project, "blog");
    await waitFor(() => expect(screen.queryByRole("link", { name: /sign-up/ })).toBeNull());
    expect(sent.map((s) => s.path)).toContain(`/tasks?project=${BLOG}`);

    await userEvent.selectOptions(project, "All projects");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "Done");
    expect(await screen.findByRole("link", { name: /Pick a theme/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done tasks" })).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Status"), "Open");
    await userEvent.click(screen.getByLabelText("Assigned to me"));
    await waitFor(() => expect(screen.queryByRole("link", { name: /first post/ })).toBeNull());
    expect(sent.map((s) => s.path)).toContain("/tasks?assignee=me");
  });

  it("says when nothing matches", async () => {
    renderWith(<WorkspacePage taskHref={taskHref} />, {
      apiBase: WS,
      routes: { "GET /tasks": { body: { tasks: [] } }, "GET /members": { body: { members } } },
    });
    expect(await screen.findByText("No open tasks")).toBeTruthy();
  });

  it("reads the tasks again every 10 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sent } = show();
    await screen.findByRole("link", { name: /Add the sign-up form/ });
    const reads = () => sent.filter((s) => s.path === "/tasks").length;
    const first = reads();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() => expect(reads()).toBeGreaterThan(first));
  });
});

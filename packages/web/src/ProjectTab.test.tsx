import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTab } from "./ProjectTab";
import { id, type Reply, renderWith } from "./test/render";
import { agent, detail, members, pullRequests, task, tasks } from "./test/samples";

afterEach(cleanup);

const base: Record<string, Reply> = {
  "GET /tasks": { body: { tasks } },
  "GET /members": { body: { members } },
  "GET /agents": { body: { agents: [agent] } },
  "GET /pull-requests": { body: { pullRequests } },
  [`GET /tasks/${detail.id}`]: { body: detail },
};

describe("ProjectTab: the task list", () => {
  it("groups the tasks by status with their counts, and opens one", async () => {
    const onSelectTask = vi.fn();
    renderWith(<ProjectTab selectedTaskId={null} onSelectTask={onSelectTask} />, {
      routes: base,
    });

    const ready = await screen.findByRole("region", { name: "Ready" });
    expect(within(ready).getByRole("heading").textContent).toBe("Ready2");
    expect(within(ready).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Claimed" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
    await screen.findByText(/Ben Okafor/);
    expect(screen.getByText(/claimed by Builder/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Add the sign-up form/ }));
    expect(onSelectTask).toHaveBeenCalledWith(detail.id);
  });

  it("offers the first task on a project without any", async () => {
    renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, {
      routes: { ...base, "GET /tasks": { body: { tasks: [] } } },
    });
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New task" })).toHaveLength(2);
  });

  it("creates a task and opens it", async () => {
    const onSelectTask = vi.fn();
    const created = task(15, { title: "Add a logo" });
    const { sent } = renderWith(<ProjectTab selectedTaskId={null} onSelectTask={onSelectTask} />, {
      routes: { ...base, "POST /tasks": { status: 201, body: created } },
    });

    await userEvent.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = screen.getByRole("dialog", { name: "New task" });
    await userEvent.type(within(dialog).getByLabelText("Title"), "  Add a logo ");
    await userEvent.type(within(dialog).getByLabelText("Description"), "The shop's logo.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create the task" }));

    await waitFor(() => expect(onSelectTask).toHaveBeenCalledWith(created.id));
    expect(sent.find((s) => s.method === "POST")?.body).toEqual({
      title: "Add a logo",
      description: "The shop's logo.",
      acceptanceCriteria: "",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the API's message when it refuses a new task", async () => {
    renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, {
      routes: {
        ...base,
        "POST /tasks": {
          status: 403,
          body: { error: { code: "forbidden", message: "This project is read-only. Upgrade." } },
        },
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: "New task" }));
    await userEvent.type(screen.getByLabelText("Title"), "Add a logo");
    await userEvent.click(screen.getByRole("button", { name: "Create the task" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This project is read-only. Upgrade.",
    );
  });

  it("namespaces its requests under the mount point", async () => {
    const { sent } = renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, {
      routes: base,
      apiBase: "/api/w/ws9/projects/p9/m/devsync",
    });
    await screen.findByRole("region", { name: "Ready" });
    expect(sent.map((s) => s.path).sort()).toEqual(["/agents", "/members", "/tasks"]);
  });

  it("asks for an unknown task's panel and says it isn't there", async () => {
    renderWith(<ProjectTab selectedTaskId={id(99)} onSelectTask={() => {}} />, {
      routes: {
        ...base,
        [`GET /tasks/${id(99)}`]: {
          status: 404,
          body: { error: { code: "not-found", message: "This task doesn't exist. Pick another." } },
        },
      },
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This task doesn't exist. Pick another.",
    );
  });
});

import type { QueryClient } from "@tanstack/react-query";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import styles from "./devsync.module.css";
import { ProjectTab } from "./ProjectTab";
import { button, id, type Reply, renderWith, testQueryClient } from "./test/render";
import {
  agent,
  detail,
  finding,
  members,
  pullRequests,
  setupComplete,
  task,
  tasks,
} from "./test/samples";

afterEach(cleanup);

const base: Record<string, Reply> = {
  "GET /tasks": { body: { tasks, nextCursor: null } },
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
      routes: { ...base, "GET /tasks": { body: { tasks: [], nextCursor: null } } },
    });
    const empty = (await screen.findByText("No tasks yet")).parentElement as HTMLElement;
    expect(screen.getAllByRole("button", { name: "New task" })).toHaveLength(1);
    expect(within(empty).getByRole("button", { name: "New task" })).toBeTruthy();
  });

  it("reads more tasks a page at a time, from the last page's cursor", async () => {
    const older = task(20, { title: "Older work", status: "READY" });
    const { sent } = renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, {
      routes: {
        ...base,
        "GET /tasks": { body: { tasks, nextCursor: "page-2" } },
        "GET /tasks?cursor=page-2": { body: { tasks: [older, tasks[0]], nextCursor: null } },
      },
    });
    const more = await screen.findByRole("button", { name: "Show more tasks" });
    expect(screen.queryByText("Older work")).toBeNull();
    await userEvent.click(more);
    expect(await screen.findByText("Older work")).toBeTruthy();
    expect(sent.map((s) => s.path)).toContain("/tasks?cursor=page-2");
    // A task on both pages shows once; the last page offers no more.
    const ready = screen.getByRole("region", { name: "Ready" });
    expect(within(ready).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more tasks" })).toBeNull();
  });

  it("offers a new task once, in the card's header, on a project with tasks", async () => {
    renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, { routes: base });
    await screen.findByRole("region", { name: "Ready" });
    expect(screen.getAllByRole("button", { name: "New task" })).toHaveLength(1);
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

describe("ProjectTab: the layout", () => {
  const routes = {
    ...base,
    [`GET /tasks/${detail.id}/runs`]: { body: { runs: [] } },
    "GET /runs/setup": { body: setupComplete },
  };

  it("shows the tasks, then the agents, with no task open", async () => {
    renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, { routes });
    const list = await screen.findByRole("region", { name: "Tasks" });
    expect(list.nextElementSibling).toBe(screen.getByRole("region", { name: "Agents" }));
    expect(screen.queryByRole("region", { name: "Add the sign-up form" })).toBeNull();
  });

  it("stacks the tasks and the agents in the column beside the open task", async () => {
    renderWith(<ProjectTab selectedTaskId={detail.id} onSelectTask={() => {}} />, { routes });
    const panel = await screen.findByRole("region", { name: "Add the sign-up form" });
    const list = screen.getByRole("region", { name: "Tasks" });
    const agents = screen.getByRole("region", { name: "Agents" });

    const column = list.parentElement as HTMLElement;
    expect(column.className).toBe(styles.side);
    expect(Array.from(column.children)).toEqual([list, agents]);
    const split = column.parentElement as HTMLElement;
    expect(split.className).toBe(styles.split);
    expect(Array.from(split.children)).toEqual([column, panel]);
    // On a narrow screen the column's cards join the panel's one column, the agents' after it.
    expect(agents.className.split(" ")).toContain(styles.agents);
  });
});

describe("ProjectTab: a security finding (?finding=)", () => {
  const found = finding();
  const FINDING_PATH = `/findings?fingerprint=${encodeURIComponent(found.fingerprint)}`;
  const GONE =
    "This finding is resolved or isn't this project's. Open it again from the project's security findings.";

  /** The tab opened from `answer`'s finding, `onFindingDone` recording where it leaves. */
  function openFinding(
    answer: Reply,
    options: { readOnly?: boolean; extra?: Record<string, Reply>; client?: QueryClient } = {},
  ) {
    const onFindingDone = vi.fn();
    const fake = renderWith(
      <ProjectTab
        selectedTaskId={null}
        onSelectTask={() => {}}
        finding={found.fingerprint}
        onFindingDone={onFindingDone}
      />,
      {
        routes: { ...base, "GET /findings": answer, ...options.extra },
        readOnly: options.readOnly,
        client: options.client,
      },
    );
    return { ...fake, onFindingDone };
  }

  it("reads the finding afresh each time the tab is opened with it", async () => {
    const client = testQueryClient();
    const first = openFinding({ body: { finding: found, task: null } }, { client });
    await screen.findByRole("dialog", { name: "New task" });
    expect(first.onFindingDone).not.toHaveBeenCalled();
    cleanup();

    // Meanwhile a task was made from it: opening the finding again opens that task.
    const linked = task(18, { title: "Fix the exposed secret" });
    const again = openFinding({ body: { finding: found, task: linked } }, { client });
    await waitFor(() => expect(again.onFindingDone).toHaveBeenCalledWith(linked.id));
    expect(again.sent.filter((s) => s.path.startsWith("/findings"))).toHaveLength(1);
  });

  it("leaves out an empty file, as it does a missing one", async () => {
    openFinding({ body: { finding: finding({ file: "", line: null }), task: null } });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(field(dialog, "Description")).not.toContain("Where");
    expect(field(dialog, "Acceptance criteria")).toBe(
      "The next security scan no longer reports config/client-exposed-secret.",
    );
  });

  const field = (dialog: HTMLElement, label: string) =>
    (within(dialog).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;

  it("reads the finding by a query parameter and offers a new task prefilled from it", async () => {
    const created = task(16, { title: `Fix: ${found.title}` });
    const { sent, onFindingDone } = openFinding(
      { body: { finding: found, task: null } },
      { extra: { "POST /tasks": { status: 201, body: created } } },
    );
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(sent.find((s) => s.path.startsWith("/findings"))?.path).toBe(FINDING_PATH);
    expect(field(dialog, "Title")).toBe("Fix: A secret is exposed to the browser");
    expect(field(dialog, "Description")).toBe(
      [
        "The value is bundled into the client's code.",
        "",
        "Where: src/app.ts:12",
        "Severity: High",
        "Rule: config/client-exposed-secret",
        "",
        "How to fix it:",
        "Read it on the server only.",
      ].join("\n"),
    );
    expect(field(dialog, "Acceptance criteria")).toBe(
      "The next security scan no longer reports config/client-exposed-secret at src/app.ts.",
    );
    expect(within(dialog).queryByText(/Not a problem/)).toBeNull();

    await userEvent.type(within(dialog).getByLabelText("Title"), " now");
    await userEvent.click(button("Create the task", dialog));
    await waitFor(() => expect(onFindingDone).toHaveBeenCalledWith(created.id));
    expect(sent.find((s) => s.method === "POST")?.body).toMatchObject({
      title: "Fix: A secret is exposed to the browser now",
      finding: { fingerprint: found.fingerprint },
    });
    // Only the fingerprint: the server reads the rest from the host.
    expect(Object.keys((sent.find((s) => s.method === "POST")?.body as object) ?? {})).toEqual([
      "title",
      "description",
      "acceptanceCriteria",
      "finding",
    ]);
  });

  it("opens the task already linked to the finding instead of offering one", async () => {
    const linked = task(17, { title: "Fix the exposed secret", status: "READY" });
    const { onFindingDone } = openFinding({ body: { finding: found, task: linked } });
    await waitFor(() => expect(onFindingDone).toHaveBeenCalledWith(linked.id));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a dismissed finding is marked Not a problem, above the form", async () => {
    openFinding({
      body: { finding: finding({ dismissal: { reason: "accepted-risk" } }), task: null },
    });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(within(dialog).getByText(/Not a problem/).textContent).toBe(
      "Marked “Not a problem” (accepted risk).",
    );
  });

  it("cuts the prefilled text to DevSync's limits, and leaves out what the finding hasn't", async () => {
    const long = finding({
      title: "t".repeat(200),
      description: "d".repeat(4000),
      remediation: "r".repeat(4000),
      file: "f".repeat(1000),
    });
    openFinding({ body: { finding: long, task: null } });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    const title = field(dialog, "Title");
    expect(title).toHaveLength(160);
    expect(title.startsWith("Fix: ttt")).toBe(true);
    expect(title.endsWith("t…")).toBe(true);
    const description = field(dialog, "Description");
    expect(description).toHaveLength(8000);
    expect(description.endsWith("r…")).toBe(true);
    cleanup();

    openFinding({
      body: {
        finding: finding({
          severity: "info",
          file: null,
          line: null,
          description: null,
          remediation: null,
        }),
        task: null,
      },
    });
    const bare = await screen.findByRole("dialog", { name: "New task" });
    expect(field(bare, "Description")).toBe("Severity: Info\nRule: config/client-exposed-secret");
    expect(field(bare, "Acceptance criteria")).toBe(
      "The next security scan no longer reports config/client-exposed-secret.",
    );
  });

  it("names the file without a line when the finding has none", async () => {
    openFinding({ body: { finding: finding({ line: null }), task: null } });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(field(dialog, "Description")).toContain("Where: src/app.ts\n");
  });

  it("closes without a task, leaving the finding", async () => {
    const { sent, onFindingDone } = openFinding({ body: { finding: found, task: null } });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.click(button("Cancel", dialog));
    expect(onFindingDone).toHaveBeenCalledWith(null);
    expect(sent.some((s) => s.method === "POST")).toBe(false);
  });

  it("shows the server's words when the finding got a task meanwhile, and stays open", async () => {
    const taken = 'This finding already has a task, "Fix the exposed secret". Open it instead.';
    const { onFindingDone } = openFinding(
      { body: { finding: found, task: null } },
      {
        extra: {
          "POST /tasks": { status: 409, body: { error: { code: "conflict", message: taken } } },
        },
      },
    );
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.click(button("Create the task", dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(taken);
    expect(onFindingDone).not.toHaveBeenCalled();
  });

  it("says a resolved finding, or another project's, is gone and offers nothing", async () => {
    const { onFindingDone } = openFinding({
      status: 404,
      body: { error: { code: "not-found", message: GONE } },
    });
    const dialog = await screen.findByRole("dialog", { name: "Security finding" });
    expect(within(dialog).getByRole("alert").textContent).toBe(GONE);
    expect(within(dialog).queryByLabelText("Title")).toBeNull();
    await userEvent.click(button("Close", dialog));
    expect(onFindingDone).toHaveBeenCalledWith(null);
  });

  it("shows the finding to a member who can't write tasks, with Create disabled", async () => {
    openFinding({ body: { finding: found, task: null } }, { readOnly: true });
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(field(dialog, "Title")).toBe("Fix: A secret is exposed to the browser");
    expect(button("Create the task", dialog).disabled).toBe(true);
    expect(button("Cancel", dialog).disabled).toBe(false);
  });
});

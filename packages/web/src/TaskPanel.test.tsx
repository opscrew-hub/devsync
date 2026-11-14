import type { TaskDetail } from "@devsync/schemas";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTab } from "./ProjectTab";
import { ME, type Reply, renderWith } from "./test/render";
import { agent, detail, members, pullRequests, setupComplete, tasks } from "./test/samples";

afterEach(cleanup);

function routes(task: TaskDetail = detail, extra: Record<string, Reply> = {}) {
  return {
    "GET /tasks": { body: { tasks } },
    "GET /members": { body: { members } },
    "GET /agents": { body: { agents: [agent] } },
    "GET /pull-requests": { body: { pullRequests } },
    [`GET /tasks/${task.id}`]: { body: task },
    [`PATCH /tasks/${task.id}`]: { body: task },
    [`GET /tasks/${task.id}/runs`]: { body: { runs: [] } },
    "GET /runs/setup": { body: setupComplete },
    ...extra,
  };
}

async function open(
  task: TaskDetail = detail,
  extra: Record<string, Reply> = {},
  onClose = vi.fn(),
) {
  const fake = renderWith(<ProjectTab selectedTaskId={task.id} onSelectTask={onClose} />, {
    routes: routes(task, extra),
  });
  const panel = await screen.findByRole("region", { name: /Add the sign-up form|Fix the/ });
  await within(panel).findByText("Description");
  return { ...fake, panel };
}

const patches = (sent: { method: string; body: unknown }[]) =>
  sent.filter((s) => s.method === "PATCH").map((s) => s.body);

describe("the task panel", () => {
  it("shows the requirements, revisions, comments and timeline, and takes the focus", async () => {
    const onClose = vi.fn();
    const { panel } = await open(detail, {}, onClose);

    expect(document.activeElement).toBe(panel);
    // The requirements, and revision 2 with the same text.
    expect(within(panel).getAllByText("A form with an email and a password.")).toHaveLength(2);
    expect(within(panel).getAllByText("The account exists after submitting.")).toHaveLength(2);
    const revisions = within(panel).getByRole("list", { name: "Revisions" });
    expect(within(revisions).getAllByRole("listitem")).toHaveLength(2);
    expect(within(revisions).getByText(/Revision 2 by Ana Lima/)).toBeTruthy();
    const comments = within(panel).getByRole("list", { name: "Comments" });
    expect(within(comments).getByText("Use the shop's colours.")).toBeTruthy();
    const timeline = within(panel).getByRole("list", { name: "Timeline" });
    expect(within(timeline).getByText("Progress reported (revision 2)")).toBeTruthy();
    expect(within(timeline).getByText("The form renders.")).toBeTruthy();
    expect(within(panel).getByText("No pull request linked.")).toBeTruthy();

    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("offers the moves the lifecycle allows and sends them with the version", async () => {
    const { panel, sent } = await open();
    const moves = within(panel).getByRole("group", { name: "Move to" });
    expect(
      within(moves)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Backlog", "In progress", "Cancelled"]);
    await userEvent.click(within(moves).getByRole("button", { name: "In progress" }));
    await waitFor(() => expect(patches(sent)).toEqual([{ version: 3, status: "IN_PROGRESS" }]));
  });

  it("lets an agent's claim move the task: only cancelling is offered", async () => {
    const claimed: TaskDetail = {
      ...detail,
      title: "Fix the checkout total",
      status: "CLAIMED",
      claim: { agentId: agent.id, agentName: "Builder", expiresAt: "2099-01-01T00:00:00Z" },
    };
    const { panel } = await open(claimed);
    const moves = within(panel).getByRole("group", { name: "Move to" });
    expect(
      within(moves)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Cancelled"]);
  });

  it("assigns the task to a member", async () => {
    const { panel, sent } = await open();
    const picker = within(panel).getByLabelText("Assignee");
    await within(picker).findByRole("option", { name: "Ana Lima" });
    await userEvent.selectOptions(picker, "Ana Lima");
    await waitFor(() => expect(patches(sent)).toEqual([{ version: 3, assigneeUserId: ME }]));
  });

  it("posts a comment", async () => {
    const posted = {
      id: detail.id,
      author: detail.creator,
      body: "Looks good.",
      createdAt: detail.createdAt,
    };
    const { panel, sent } = await open(detail, {
      [`POST /tasks/${detail.id}/comments`]: { status: 201, body: posted },
    });
    await userEvent.type(within(panel).getByLabelText("Comment"), "Looks good.");
    await userEvent.click(within(panel).getByRole("button", { name: "Post the comment" }));
    await waitFor(() =>
      expect(sent.find((s) => s.method === "POST")?.body).toEqual({ body: "Looks good." }),
    );
    await waitFor(() =>
      expect((within(panel).getByLabelText("Comment") as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("checks a comment before sending it", async () => {
    const { panel, sent } = await open();
    await userEvent.type(within(panel).getByLabelText("Comment"), "   ");
    await userEvent.click(within(panel).getByRole("button", { name: "Post the comment" }));
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "Fill in the required fields and keep each within its limit, then try again.",
    );
    expect(sent.filter((s) => s.method === "POST")).toEqual([]);
  });

  it("links a pull request, and shows the linked one with its state", async () => {
    const { panel, sent } = await open(detail, {
      [`PUT /tasks/${detail.id}/pull-request`]: { body: { ...tasks[0], pullRequestNumber: 42 } },
    });
    const picker = within(panel).getByLabelText("Linked pull request");
    await within(picker).findByRole("option", { name: "#42 Sign-up form (Open)" });
    await userEvent.selectOptions(picker, "#42 Sign-up form (Open)");
    await waitFor(() => expect(sent.find((s) => s.method === "PUT")?.body).toEqual({ number: 42 }));
    cleanup();

    const linked = { ...detail, pullRequestNumber: 42, pullRequest: pullRequests[0] ?? null };
    const again = await open(linked);
    const link = within(again.panel).getByRole("link", { name: "#42 Sign-up form" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/shop/pull/42");
    expect(within(again.panel).getByText("Open")).toBeTruthy();
  });

  it("keeps a refused edit's text, says why, and saves against the reloaded version", async () => {
    let version = 3;
    const refusal = {
      status: 409,
      body: { error: { code: "conflict", message: "This task changed. Reload it and try again." } },
    };
    const { panel, sent } = await open(detail, {
      // Someone else saved first: the task is now at version 4.
      [`GET /tasks/${detail.id}`]: () => ({ body: { ...detail, version } }),
      [`PATCH /tasks/${detail.id}`]: (request) => {
        const body = request.body as { version: number };
        if (body.version !== version) return refusal;
        return { body: { ...tasks[0], version: version + 1 } };
      },
    });
    version = 4;

    await userEvent.click(within(panel).getByRole("button", { name: "Edit the requirements" }));
    const form = within(panel).getByRole("form", { name: "Edit the requirements" });
    const title = within(form).getByLabelText("Title");
    await userEvent.clear(title);
    await userEvent.type(title, "Add the sign-up and sign-in forms");
    await userEvent.click(within(form).getByRole("button", { name: "Save the requirements" }));

    expect((await within(form).findByRole("alert")).textContent).toBe(
      "This task changed. Reload it and try again.",
    );
    expect((title as HTMLInputElement).value).toBe("Add the sign-up and sign-in forms");
    expect(patches(sent)).toEqual([
      {
        version: 3,
        title: "Add the sign-up and sign-in forms",
        description: detail.description,
        acceptanceCriteria: detail.acceptanceCriteria,
      },
    ]);

    await userEvent.click(within(form).getByRole("button", { name: "Reload the task" }));
    await userEvent.click(within(form).getByRole("button", { name: "Save the requirements" }));
    await waitFor(() => expect(patches(sent)).toHaveLength(2));
    expect(patches(sent)[1]).toMatchObject({
      version: 4,
      title: "Add the sign-up and sign-in forms",
    });
    await waitFor(() => expect(within(panel).queryByRole("form")).toBeNull());
  });

  it("locks nothing a Developer may do on a task", async () => {
    renderWith(<ProjectTab selectedTaskId={detail.id} onSelectTask={() => {}} />, {
      routes: routes(),
      role: "developer",
    });
    const edit = await screen.findByRole("button", { name: "Edit the requirements" });
    expect((edit as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

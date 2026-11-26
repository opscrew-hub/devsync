import type { PullRequest, Question, TaskDetail } from "@devsync/schemas";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTab } from "./ProjectTab";
import { button, id, ME, type Reply, renderWith } from "./test/render";
import {
  agent,
  ana,
  at,
  builder,
  detail,
  members,
  pullRequests,
  setupComplete,
  tasks,
} from "./test/samples";

afterEach(cleanup);

function routes(task: TaskDetail = detail, extra: Record<string, Reply> = {}) {
  return {
    "GET /tasks": { body: { tasks, nextCursor: null } },
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

/** The panel of `task` with `questions`. */
const withQuestions = (
  task: TaskDetail,
  questions: Question[],
  extra: Record<string, Reply> = {},
) => open({ ...task, questions }, extra);

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

  it("shows a linked pull request outside GitHub as text, not as a link", async () => {
    const elsewhere = { ...(pullRequests[0] as PullRequest), url: "https://example.com/pull/42" };
    const { panel } = await open({ ...detail, pullRequestNumber: 42, pullRequest: elsewhere });
    expect(within(panel).getByText("#42 Sign-up form")).toBeTruthy();
    expect(within(panel).queryByRole("link", { name: /Sign-up form/ })).toBeNull();
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
    await waitFor(() =>
      expect(within(panel).queryByRole("form", { name: "Edit the requirements" })).toBeNull(),
    );
  });

  it("shows the paths, the tasks it waits for, the labels and the branch, and what waits", async () => {
    const waiting: TaskDetail = {
      ...detail,
      owns: ["src/signup/", "README.md"],
      dependsOn: [id(11), id(12)],
      labels: ["auth", "ui"],
      branch: "feature/signup",
      dependencies: [
        { id: id(11), title: "Send the welcome email", status: "REVIEW" },
        { id: id(12), title: "Write the privacy page", status: "DONE" },
      ],
    };
    const { panel } = await open(waiting);
    const fields = within(panel).getByRole("region", { name: "Paths and dependencies" });
    expect(within(fields).getByText("src/signup/")).toBeTruthy();
    expect(within(fields).getByText("README.md")).toBeTruthy();
    expect(within(fields).getByText("auth")).toBeTruthy();
    expect(within(fields).getByText("feature/signup")).toBeTruthy();
    const deps = within(fields).getByRole("list", { name: "Waits for" });
    expect(
      within(deps)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Send the welcome email (Review)", "Write the privacy page (Done)"]);
    expect(within(fields).getByRole("status").textContent).toBe(
      'Waits for "Send the welcome email": agents can claim it once that is done.',
    );
  });

  it("flags the other open tasks whose paths overlap, with the paths they share", async () => {
    const overlapping: TaskDetail = {
      ...detail,
      owns: ["src/"],
      overlaps: [
        {
          task: { id: id(13), title: "Fix the checkout total", status: "CLAIMED" },
          paths: ["src/checkout/total.ts", "src/checkout/tax.ts"],
        },
      ],
    };
    const { panel } = await open(overlapping);
    const fields = within(panel).getByRole("region", { name: "Paths and dependencies" });
    expect(within(fields).getByText("Shares paths with 1 other open task:")).toBeTruthy();
    const list = within(fields).getByRole("list", { name: "Overlapping tasks" });
    expect(within(list).getByRole("listitem").textContent).toBe(
      "Fix the checkout total (Claimed): src/checkout/total.ts, src/checkout/tax.ts",
    );
    cleanup();
    const plain = await open(detail);
    expect(within(plain.panel).queryByRole("list", { name: "Overlapping tasks" })).toBeNull();
    expect(within(plain.panel).queryByRole("status")).toBeNull();
    expect(within(plain.panel).getByText("No paths given.")).toBeTruthy();
  });

  it("edits the fields: paths one per line, the tasks it waits for, labels and branch", async () => {
    const { panel, sent } = await open(detail, {
      [`PATCH /tasks/${detail.id}`]: { body: tasks[0] },
    });
    await userEvent.click(within(panel).getByRole("button", { name: "Edit the fields" }));
    const form = within(panel).getByRole("form", { name: "Edit the fields" });
    await userEvent.type(
      within(form).getByLabelText("Paths it may change, one per line"),
      "src/signup/{enter}  README.md {enter}{enter}src/signup/",
    );
    const waitsFor = within(form).getByLabelText("Waits for") as HTMLSelectElement;
    // The project's other open tasks: not itself, not one that is Done or Cancelled.
    await within(waitsFor).findByRole("option", { name: "Send the welcome email (Ready)" });
    expect(
      within(waitsFor)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Send the welcome email (Ready)",
      "Write the privacy page (Backlog)",
      "Fix the checkout total (Claimed)",
    ]);
    await userEvent.selectOptions(waitsFor, ["Send the welcome email (Ready)"]);
    await userEvent.type(
      within(form).getByLabelText("Labels, one per line"),
      "auth{enter}Auth{enter}ui",
    );
    await userEvent.type(within(form).getByLabelText("Branch"), "feature/signup");
    await userEvent.click(within(form).getByRole("button", { name: "Save the fields" }));
    await waitFor(() =>
      expect(patches(sent)).toEqual([
        {
          version: 3,
          owns: ["src/signup/", "README.md"],
          dependsOn: [id(11)],
          labels: ["auth", "ui"],
          branch: "feature/signup",
        },
      ]),
    );
    await waitFor(() =>
      expect(within(panel).queryByRole("form", { name: "Edit the fields" })).toBeNull(),
    );
  });

  it("clears the branch and the tasks it waits for, and says why a bad field is refused", async () => {
    const set: TaskDetail = {
      ...detail,
      dependsOn: [id(11)],
      branch: "feature/signup",
      dependencies: [{ id: id(11), title: "Send the welcome email", status: "READY" }],
    };
    const { panel, sent } = await open(set);
    await userEvent.click(within(panel).getByRole("button", { name: "Edit the fields" }));
    const form = within(panel).getByRole("form", { name: "Edit the fields" });
    await userEvent.deselectOptions(within(form).getByLabelText("Waits for"), [
      "Send the welcome email (Ready)",
    ]);
    await userEvent.clear(within(form).getByLabelText("Branch"));
    await userEvent.click(within(form).getByRole("button", { name: "Save the fields" }));
    await waitFor(() =>
      expect(patches(sent)).toEqual([
        { version: 3, owns: [], dependsOn: [], labels: [], branch: null },
      ]),
    );
    cleanup();

    const again = await open(detail);
    await userEvent.click(within(again.panel).getByRole("button", { name: "Edit the fields" }));
    const bad = within(again.panel).getByRole("form", { name: "Edit the fields" });
    await userEvent.type(within(bad).getByLabelText("Branch"), "has space");
    await userEvent.click(within(bad).getByRole("button", { name: "Save the fields" }));
    expect((await within(bad).findByRole("alert")).textContent).toBe(
      "Fill in the required fields and keep each within its limit, then try again.",
    );
    expect(patches(again.sent)).toEqual([]);
  });

  it("shows the agents' reported usage beside the managed runs', kept apart", async () => {
    const used: TaskDetail = {
      ...detail,
      usage: {
        agents: {
          inputTokens: 12000,
          outputTokens: 3400,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 50000,
          costUsd: 0.42,
          models: ["claude-opus"],
          count: 3,
        },
        runs: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationInputTokens: 10,
          cacheReadInputTokens: 30,
          costUsd: 1.5,
          models: [],
          count: 1,
        },
      },
    };
    const { panel } = await open(used);
    const usage = within(panel).getByRole("region", { name: "Usage" });
    expect(within(usage).getByText("Agents' reports")).toBeTruthy();
    expect(
      within(usage).getByText(
        "12,000 input · 3,400 output · 50,000 cache read · 0 cache written · ≈ $0.42, the agents' own estimate, from 3 reports (claude-opus)",
      ),
    ).toBeTruthy();
    expect(
      within(usage).getByText(
        "1,000 input · 200 output · 30 cache read · 10 cache written · ≈ $1.50, from 1 run",
      ),
    ).toBeTruthy();
    cleanup();
    const none = await open(detail);
    expect(within(none.panel).queryByRole("region", { name: "Usage" })).toBeNull();
  });

  it("shows the questions as the server orders them, each with who asked and the answer", async () => {
    const answered: Question = {
      id: id(40),
      taskId: detail.id,
      askedBy: builder,
      text: "Which fields?",
      wait: false,
      status: "ANSWERED",
      answer: "Email and password.",
      answeredBy: ana,
      createdAt: at,
      answeredAt: at,
    };
    const waiting: Question = {
      ...answered,
      id: id(41),
      text: "Should it confirm the email?",
      wait: true,
      status: "OPEN",
      answer: null,
      answeredBy: null,
      answeredAt: null,
    };
    const { panel } = await withQuestions(detail, [waiting, answered]);
    const section = within(panel).getByRole("region", { name: "Questions" });
    const items = within(within(section).getByRole("list", { name: "Questions" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    const [first, second] = items as [HTMLElement, HTMLElement];
    expect(within(first).getByText("Should it confirm the email?")).toBeTruthy();
    expect(within(first).getByText(/^Builder, /)).toBeTruthy();
    expect(within(first).getByText("Open: the task waits for its answer")).toBeTruthy();
    expect(within(first).getByRole("form", { name: "Answer the question" })).toBeTruthy();
    expect(within(second).getByText("Which fields?")).toBeTruthy();
    expect(within(second).getByText(/^Answered by Ana Lima, /)).toBeTruthy();
    expect(within(second).getByText("Email and password.")).toBeTruthy();
    expect(within(second).queryByRole("form")).toBeNull();
    cleanup();

    const none = await withQuestions(detail, []);
    expect(within(none.panel).getByText("No questions yet.")).toBeTruthy();
    expect(within(none.panel).queryByText(/older answered/)).toBeNull();
  });

  it("says how many older answered questions it doesn't show", async () => {
    const answered: Question = {
      id: id(40),
      taskId: detail.id,
      askedBy: builder,
      text: "Which fields?",
      wait: false,
      status: "ANSWERED",
      answer: "Email and password.",
      answeredBy: ana,
      createdAt: at,
      answeredAt: at,
    };
    const many = await open({ ...detail, questions: [answered], answeredNotShown: 12 });
    const section = within(many.panel).getByRole("region", { name: "Questions" });
    expect(within(section).getByText("12 older answered questions aren't shown.")).toBeTruthy();
    cleanup();
    const one = await open({ ...detail, questions: [answered], answeredNotShown: 1 });
    expect(within(one.panel).getByText("1 older answered question isn't shown.")).toBeTruthy();
  });

  it("says how many older revisions, comments and events, and later overlaps, it doesn't show", async () => {
    const overlap = {
      task: { id: id(13), title: "Fix the checkout total", status: "CLAIMED" as const },
      paths: ["src/checkout/total.ts"],
    };
    const { panel } = await open({
      ...detail,
      owns: ["src/"],
      overlaps: [overlap],
      revisionsNotShown: 48,
      commentsNotShown: 1,
      timelineNotShown: 7,
      overlapsNotShown: 3,
    });
    expect(within(panel).getByText("48 older revisions aren't shown.")).toBeTruthy();
    expect(within(panel).getByText("1 older comment isn't shown.")).toBeTruthy();
    expect(within(panel).getByText("7 older events aren't shown.")).toBeTruthy();
    const fields = within(panel).getByRole("region", { name: "Paths and dependencies" });
    expect(within(fields).getByText("Shares paths with 4 other open tasks:")).toBeTruthy();
    expect(within(fields).getByText("3 more tasks aren't shown.")).toBeTruthy();
    cleanup();
    const plain = await open(detail);
    expect(within(plain.panel).queryByText(/aren't shown|isn't shown/)).toBeNull();
  });

  it("answers an open question and asks one, each checked before it is sent", async () => {
    const asked: Question = {
      id: id(41),
      taskId: detail.id,
      askedBy: builder,
      text: "Should it confirm the email?",
      wait: false,
      status: "OPEN",
      answer: null,
      answeredBy: null,
      createdAt: at,
      answeredAt: null,
    };
    const answered = { ...asked, status: "ANSWERED", answer: "Yes.", answeredBy: ana };
    const { panel, sent } = await withQuestions(detail, [asked], {
      [`POST /questions/${asked.id}/answer`]: { body: answered },
      [`POST /tasks/${detail.id}/questions`]: { status: 201, body: { ...asked, id: id(42) } },
    });
    const posts = () => sent.filter((s) => s.method === "POST");
    const answerForm = within(panel).getByRole("form", { name: "Answer the question" });
    await userEvent.type(within(answerForm).getByLabelText("Answer"), "  ");
    await userEvent.click(within(answerForm).getByRole("button", { name: "Post the answer" }));
    expect((await within(answerForm).findByRole("alert")).textContent).toBe(
      "Fill in the required fields and keep each within its limit, then try again.",
    );
    expect(posts()).toEqual([]);
    await userEvent.type(within(answerForm).getByLabelText("Answer"), "Yes.");
    await userEvent.click(within(answerForm).getByRole("button", { name: "Post the answer" }));
    await waitFor(() =>
      expect(posts()).toEqual([
        { method: "POST", path: `/questions/${asked.id}/answer`, body: { answer: "Yes." } },
      ]),
    );

    const askForm = within(panel).getByRole("form", { name: "Ask a question" });
    await userEvent.type(within(askForm).getByLabelText("Question"), "Which provider?");
    await userEvent.click(within(askForm).getByRole("button", { name: "Ask the question" }));
    await waitFor(() =>
      expect(posts()[1]).toEqual({
        method: "POST",
        path: `/tasks/${detail.id}/questions`,
        body: { text: "Which provider?" },
      }),
    );
    await waitFor(() =>
      expect((within(askForm).getByLabelText("Question") as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("locks asking and answering on a read-only project, and asking on a closed task", async () => {
    const asked: Question = {
      id: id(41),
      taskId: detail.id,
      askedBy: builder,
      text: "Should it confirm the email?",
      wait: false,
      status: "OPEN",
      answer: null,
      answeredBy: null,
      createdAt: at,
      answeredAt: null,
    };
    const task = { ...detail, questions: [asked] };
    renderWith(<ProjectTab selectedTaskId={task.id} onSelectTask={() => {}} />, {
      routes: routes(task),
      readOnly: true,
    });
    expect(
      button("Post the answer", await screen.findByRole("region", { name: "Questions" })),
    ).toHaveProperty("disabled", true);
    expect(button("Ask the question")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Question")).toHaveProperty("disabled", true);
    cleanup();

    const done = await withQuestions({ ...task, status: "DONE" }, [asked]);
    expect(within(done.panel).queryByRole("form", { name: "Ask a question" })).toBeNull();
    expect(within(done.panel).getByText("A Done task takes no more questions.")).toBeTruthy();
    // Its open questions can still be answered.
    expect(button("Post the answer", done.panel).disabled).toBe(false);
  });

  it("locks editing a Done or Cancelled task's requirements, saying why, but not its fields", async () => {
    for (const status of ["DONE", "CANCELLED"] as const) {
      const { panel } = await open({ ...detail, status });
      expect(button("Edit the requirements", panel).disabled).toBe(true);
      expect(within(panel).getByText(/its requirements stay as they are/)).toBeTruthy();
      expect(button("Edit the fields", panel).disabled).toBe(false);
      cleanup();
    }
  });

  it("locks editing the fields on a read-only project", async () => {
    renderWith(<ProjectTab selectedTaskId={detail.id} onSelectTask={() => {}} />, {
      routes: routes(),
      readOnly: true,
    });
    const edit = await screen.findByRole("button", { name: "Edit the fields" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
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

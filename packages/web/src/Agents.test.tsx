import type { Agent } from "@devsync/schemas";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTab } from "./ProjectTab";
import { button, id, type Reply, renderWith } from "./test/render";
import { agent, members, tasks } from "./test/samples";

afterEach(cleanup);

const POINTER =
  "Agents are registered, and their tokens rotated and revoked, from the Agents button at the top of this project's page.";

/** One of the host's agents that hasn't connected to DevSync yet. */
const fresh: Agent = {
  id: id(32),
  name: "Helper",
  kind: "OTHER",
  status: "Offline",
  expiresAt: null,
  lastSeenAt: null,
  createdAt: null,
};

function show(
  role: "owner" | "admin" | "approver" | "developer",
  extra: Record<string, Reply> = {},
) {
  return renderWith(<ProjectTab selectedTaskId={null} onSelectTask={() => {}} />, {
    role,
    routes: {
      "GET /tasks": { body: { tasks } },
      "GET /members": { body: { members } },
      "GET /agents": { body: { agents: [agent] } },
      ...extra,
    },
  });
}

describe("the Agents card", () => {
  it("points every role to the project's Agents button, and registers, rotates and revokes none", async () => {
    for (const role of ["owner", "admin", "approver", "developer"] as const) {
      show(role);
      const actions = await screen.findByRole("group", { name: "Builder" });
      const card = screen.getByRole("region", { name: "Agents" });
      expect(within(card).getByText(POINTER)).toBeTruthy();
      for (const name of [/Register/, /Rotate/, /Revoke/]) {
        expect(within(card).queryByRole("button", { name })).toBeNull();
      }
      expect(
        within(actions)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["Send a message"]);
      cleanup();
    }
  });

  it("says where to register the first agent when there is none", async () => {
    show("owner", { "GET /agents": { body: { agents: [] } } });
    const empty = (await screen.findByText("No agents yet")).parentElement as HTMLElement;
    expect(
      within(empty).getByText(/the Agents button at the top of this project's page/),
    ).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Register/ })).toEqual([]);
  });

  it("shows the host's agents, and the token's end only for DevSync's own", async () => {
    show("developer", {
      "GET /agents": {
        body: {
          agents: [
            { ...agent, id: id(33), name: "Reviewer", expiresAt: null },
            fresh,
            agent,
            // The host's, which DevSync revoked before its move.
            { ...agent, id: id(34), name: "Gone", status: "Revoked", expiresAt: null },
          ],
        },
      },
    });
    const list = await screen.findByRole("list", { name: "Agents" });
    const [hosts, waiting, own, gone] = within(list).getAllByRole("listitem");
    expect(gone?.textContent).toContain("Revoked");
    expect(button("Send a message", gone as HTMLElement).disabled).toBe(true);
    expect(hosts?.textContent).not.toContain("token valid until");
    expect(own?.textContent).toContain("token valid until");
    expect(waiting?.textContent).toContain("Other agent");
    expect(waiting?.textContent).toContain(
      "Not connected yet: it can get messages once it has connected to DevSync",
    );
    expect(button("Send a message", waiting as HTMLElement).disabled).toBe(true);
    expect(button("Send a message", hosts as HTMLElement).disabled).toBe(false);
  });

  it("sends an agent a message with one idempotency key", async () => {
    const { sent } = show("developer", {
      [`POST /agents/${agent.id}/messages`]: {
        status: 201,
        body: { id: id(40), kind: "clarification.answered", createdAt: agent.createdAt },
      },
    });
    const actions = await screen.findByRole("group", { name: "Builder" });
    await userEvent.click(button("Send a message", actions));
    const dialog = screen.getByRole("dialog", { name: "Message Builder" });
    await userEvent.type(within(dialog).getByLabelText("Message"), "Use the blue button.");
    await userEvent.click(button("Send", dialog));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const body = sent.find((s) => s.method === "POST")?.body as Record<string, string>;
    expect(body).toMatchObject({ kind: "clarification.answered", message: "Use the blue button." });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});

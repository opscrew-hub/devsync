import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { useChange } from "./queries";
import { API, renderWith } from "./test/render";

afterEach(cleanup);

/** The workspace page's mount beside the project tab's (`API`), as the host gives them. */
const WORKSPACE_API = "/api/w/ws1/m/devsync";

function Change() {
  const change = useChange(z.object({}), (api) =>
    api.send("PATCH", "/tasks/t1", { status: "done" }, z.unknown()),
  );
  return (
    <button type="button" onClick={() => change.mutate({})}>
      Change
    </button>
  );
}

describe("a change", () => {
  it("leaves every DevSync list stale, the workspace page's too, so going back reads it again", async () => {
    // The host keeps answers fresh for 30 seconds: without the change marking them stale, the
    // workspace page would show its old list when the person goes back to it.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const workspaceList = ["devsync", WORKSPACE_API, "/tasks"];
    const projectList = ["devsync", API, "/tasks"];
    const setup = ["devsync-setup", API];
    for (const key of [workspaceList, projectList, setup]) client.setQueryData(key, { tasks: [] });

    renderWith(<Change />, { routes: { "PATCH /tasks/t1": { body: {} } }, client });
    await userEvent.setup().click(screen.getByRole("button", { name: "Change" }));

    await waitFor(() => expect(client.getQueryState(workspaceList)?.isInvalidated).toBe(true));
    expect(client.getQueryState(projectList)?.isInvalidated).toBe(true);
    // What a runs section reads costs GitHub calls: a change doesn't read it again.
    expect(client.getQueryState(setup)?.isInvalidated).toBe(false);
  });
});

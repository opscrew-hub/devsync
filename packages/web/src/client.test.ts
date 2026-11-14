import { MemberList } from "@devsync/schemas";
import { describe, expect, it } from "vitest";
import { createClient, DevSyncRequestError } from "./client";

const answer = (status: number, body?: unknown) => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("createClient", () => {
  it("sends JSON with the session cookie under the mount point", async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const api = createClient("/api/x", async (input, init) => {
      seen.push([input, init]);
      return new Response(JSON.stringify({ members: [] }));
    });
    await api.send("POST", "/members", { a: 1 }, MemberList);
    const [url, init] = seen[0] ?? [];
    expect(url).toBe("/api/x/members");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(init?.body).toBe('{"a":1}');
  });

  it("turns a refusal into an error with its code, status and message", async () => {
    const api = createClient(
      "",
      answer(409, {
        error: { code: "conflict", message: "This task changed. Reload it and try again." },
      }),
    );
    const error = await api.get("/tasks", MemberList).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DevSyncRequestError);
    expect(error).toMatchObject({
      code: "conflict",
      status: 409,
      message: "This task changed. Reload it and try again.",
    });
  });

  it("refuses an answer that isn't the API's shape", async () => {
    const api = createClient("", answer(200, { members: [{ name: 1 }] }));
    await expect(api.get("/members", MemberList)).rejects.toMatchObject({ code: "unexpected" });
    const broken = createClient("", answer(500, "<html>"));
    await expect(broken.get("/members", MemberList)).rejects.toMatchObject({
      code: "unexpected",
      status: 500,
    });
  });

  it("says when DevSync can't be reached", async () => {
    const api = createClient("", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.get("/members", MemberList)).rejects.toMatchObject({
      code: "network",
      status: 0,
      message: "DevSync couldn't be reached. Check your connection and try again in a moment.",
    });
  });

  it("answers nothing for a 204", async () => {
    const api = createClient("", answer(204));
    await expect(api.send("DELETE", "/agents/1")).resolves.toBeUndefined();
  });
});

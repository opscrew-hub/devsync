import { describe, expect, it } from "vitest";
import { ErrorAnswer } from "./common";

describe("ErrorAnswer", () => {
  it("takes a refusal with its fields, and an unexpected failure as internal", () => {
    expect(
      ErrorAnswer.parse({
        error: { code: "invalid", message: "Check this field.", fields: ["title"] },
      }),
    ).toEqual({ error: { code: "invalid", message: "Check this field.", fields: ["title"] } });
    expect(
      ErrorAnswer.parse({ error: { code: "internal", message: "Try again." } }).error.code,
    ).toBe("internal");
    expect(ErrorAnswer.safeParse({ error: { code: "teapot", message: "No." } }).success).toBe(
      false,
    );
  });
});

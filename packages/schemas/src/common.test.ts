import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorAnswer, Id } from "./common";

describe("Id", () => {
  it("takes the UUIDs zod's uuid takes, and nothing else", () => {
    const uuid = z.uuid();
    for (const value of [
      randomUUID(),
      randomUUID().toUpperCase(),
      "00000000-0000-4000-8000-0000000000a1",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "00000000-0000-9000-8000-000000000000",
      "00000000-0000-4000-c000-000000000000",
      "not-a-uuid",
      `${randomUUID()} `,
      "",
    ]) {
      expect(Id.safeParse(value).success, value).toBe(uuid.safeParse(value).success);
    }
    expect(Id.safeParse(1).success).toBe(false);
  });

  it("is a string of format uuid in a JSON Schema, without zod's long pattern", () => {
    const { $schema: _, ...schema } = z.toJSONSchema(Id) as Record<string, unknown>;
    expect(schema).toEqual({ type: "string", format: "uuid" });
    expect(z.toJSONSchema(z.strictObject({ id: Id.nullable() }))).toMatchObject({
      properties: { id: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] } },
    });
  });
});

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

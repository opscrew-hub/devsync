import { ErrorAnswer } from "@devsync/schemas";
import type { z } from "zod";

/** The `fetch` the client calls: `globalThis.fetch` unless the provider is given another. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What a refusal's `code` can be, and `network` or `unexpected` when there was no API answer. */
export type ErrorCode = ErrorAnswer["error"]["code"] | "network" | "unexpected";

/**
 * A failed request: the API's code and plain-English message, or `network` when DevSync couldn't
 * be reached and `unexpected` when its answer wasn't the API's shape. `status` is 0 without an answer.
 */
export class DevSyncRequestError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = "DevSyncRequestError";
    this.code = code;
    this.status = status;
  }
}

/** DevSync's API under one mount point; every answer is parsed with its schema. */
export interface DevSyncClient {
  get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>>;
  /** POST, PUT, PATCH or DELETE; answers `undefined` without a schema (204). */
  send<S extends z.ZodType>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    schema?: S,
  ): Promise<z.infer<S>>;
}

const UNREACHABLE = "DevSync couldn't be reached. Check your connection and try again in a moment.";
const UNEXPECTED =
  "DevSync answered in a way this page didn't expect. Reload the page and try again.";

/** Requests go to the dashboard's own origin, with its session cookie, as JSON. */
export function createClient(apiBase: string, doFetch: FetchLike): DevSyncClient {
  async function request(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(`${apiBase}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new DevSyncRequestError("network", UNREACHABLE, 0);
    }
    const json = parseJson(await response.text());
    if (!response.ok) {
      const refusal = ErrorAnswer.safeParse(json);
      if (!refusal.success)
        throw new DevSyncRequestError("unexpected", UNEXPECTED, response.status);
      throw new DevSyncRequestError(
        refusal.data.error.code,
        refusal.data.error.message,
        response.status,
      );
    }
    if (!schema) return undefined;
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new DevSyncRequestError("unexpected", UNEXPECTED, response.status);
    return parsed.data;
  }

  return {
    get: (path, schema) => request("GET", path, undefined, schema) as never,
    send: (method, path, body, schema) => request(method, path, body, schema) as never,
  };
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

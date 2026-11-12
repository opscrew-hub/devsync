import { setTimeout } from "node:timers/promises";

export function projectEventStream(
  readVersion: () => Promise<string | null>,
  requestSignal: AbortSignal,
  pollInterval = 2000,
) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([requestSignal, stopped.signal, AbortSignal.timeout(50000)]);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        let previous: string | undefined;
        let heartbeat = Date.now();
        while (!signal.aborted) {
          const version = await readVersion();
          if (signal.aborted) break;
          if (version === null) {
            controller.enqueue(encoder.encode("event: access-revoked\ndata: {}\n\n"));
            break;
          }
          if (version !== previous) {
            controller.enqueue(encoder.encode(`event: project-refresh\ndata: ${version}\n\n`));
            previous = version;
            heartbeat = Date.now();
          } else if (Date.now() - heartbeat >= 10000) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            heartbeat = Date.now();
          }
          await setTimeout(pollInterval, undefined, { signal });
        }
      } catch (error) {
        if (!signal.aborted) {
          controller.error(error);
          return;
        }
      }
      if (!stopped.signal.aborted) controller.close();
    },
    cancel() {
      stopped.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

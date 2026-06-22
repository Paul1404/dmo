import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/server/auth";
import { subscribeToUserEvents } from "~/server/live";

const encoder = new TextEncoder();

function encodeSse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handle({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  const userId = session.user.id;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      controller.enqueue(encodeSse("connected", { at: new Date().toISOString() }));

      const unsubscribe = subscribeToUserEvents(userId, (event) => {
        controller.enqueue(encodeSse(event.type, event));
      });
      const heartbeat = setInterval(() => {
        controller.enqueue(encodeSse("heartbeat", { at: new Date().toISOString() }));
      }, 25_000);

      function cleanup() {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The stream may already be closed by the runtime.
        }
      }

      request.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}

export const Route = createFileRoute("/api/live")({
  server: {
    handlers: {
      GET: handle,
    },
  },
});

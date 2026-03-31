import type { ServerResponse } from "node:http";

/** Initialize SSE response headers. */
export function initSSE(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** Send a named SSE event. */
export function sendEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Send an SSE comment (heartbeat). */
export function sendHeartbeat(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.write(": heartbeat\n\n");
}

/** End the SSE stream. */
export function endSSE(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.end();
}

/**
 * Start a heartbeat interval that sends SSE comments every `ms` milliseconds.
 * Returns a cleanup function.
 */
export function startHeartbeat(
  res: ServerResponse,
  ms = 15_000,
): () => void {
  const timer = setInterval(() => sendHeartbeat(res), ms);
  return () => clearInterval(timer);
}

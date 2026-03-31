import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const token = process.env.CC_GATEWAY_API_TOKEN;

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to burn constant time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validates Bearer token from Authorization header.
 * Returns true if authorized, false if response was already sent with 401.
 * If no CC_GATEWAY_API_TOKEN is configured, all requests pass through.
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!token) return true;

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid Authorization header" }));
    return false;
  }

  const provided = auth.slice(7);
  if (!timingSafeCompare(provided, token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid API token" }));
    return false;
  }

  return true;
}

import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayState, SessionInfo } from "./types.js";

const STATE_DIR = path.join(
  process.env.HOME ?? "/root",
  ".cc-gateway",
);
const STATE_FILE = path.join(STATE_DIR, "state.json");
const TMP_FILE = path.join(STATE_DIR, "state.json.tmp");

let writeQueue: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

/** Read persisted state, or null if none exists. */
async function readState(): Promise<GatewayState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as GatewayState;
  } catch {
    return null;
  }
}

/** Atomic write: write to tmp file then rename. */
export function writeState(state: GatewayState): Promise<void> {
  const doWrite = async () => {
    await ensureDir();
    await fs.writeFile(TMP_FILE, JSON.stringify(state, null, 2));
    await fs.rename(TMP_FILE, STATE_FILE);
  };
  writeQueue = writeQueue.then(doWrite, doWrite);
  return writeQueue;
}

/**
 * Initialize gateway state. Recovers orphaned "running" sessions on restart.
 */
export async function initState(port: number): Promise<GatewayState> {
  await ensureDir();
  const existing = await readState();

  if (existing) {
    existing.server = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      port,
      version: "0.1.0",
    };

    // Mark any orphaned running sessions as failed
    for (const session of Object.values(existing.sessions)) {
      if (session.status === "running") {
        session.status = "failed";
        session.error = "Server restarted while session was running";
        session.updated_at = new Date().toISOString();
      }
    }

    await writeState(existing);
    return existing;
  }

  const state: GatewayState = {
    server: {
      pid: process.pid,
      started_at: new Date().toISOString(),
      port,
      version: "0.1.0",
    },
    sessions: {},
  };
  await writeState(state);
  return state;
}

/** Update a session in state and persist. */
export async function updateSession(
  state: GatewayState,
  id: string,
  update: Partial<SessionInfo>,
): Promise<void> {
  const session = state.sessions[id];
  if (!session) return;
  Object.assign(session, update, { updated_at: new Date().toISOString() });
  await writeState(state);
}

/** Remove a session from state and persist. */
export async function removeSession(
  state: GatewayState,
  id: string,
): Promise<void> {
  delete state.sessions[id];
  await writeState(state);
}

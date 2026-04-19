#!/usr/bin/env python3
"""
Backfill agent_sessions in D1 from ~/.claude/projects JSONL files + gateway .meta.json.

Usage:
  python3 scripts/backfill-d1-sessions.py --user-id <id> --dry-run
  python3 scripts/backfill-d1-sessions.py --user-id <id>

Reads:
  - ~/.claude/projects/-data-projects-*/*.jsonl  (session transcripts)
  - $GATEWAY_DIR (default /run/duraclaw/sessions) *.meta.json + *.cmd

Writes:
  - INSERT OR REPLACE into agent_sessions via wrangler d1 execute --remote

Options:
  --user-id ID              Owning user_id to stamp on every row (required unless
                            --dry-run; can also be supplied via
                            DURACLAW_BACKFILL_USER_ID).
  --dry-run                 Print SQL preview, do not invoke wrangler.
  --gateway-dir PATH        Override gateway sessions dir (also via
                            $GATEWAY_DIR). Default: /run/duraclaw/sessions.
  --orchestrator-dir PATH   Directory to cd into before calling wrangler.
                            Default: <repo>/apps/orchestrator resolved relative
                            to this script's location.
  --use-wrangler-auth       Strip CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
                            from the subprocess env so wrangler falls back to
                            its own stored credentials. Default: inherit env.
"""

import argparse
import json
import os
import glob
import sys
import subprocess
from datetime import datetime
from collections import defaultdict

CLAUDE_PROJECTS = os.path.expanduser("~/.claude/projects")
DEFAULT_GATEWAY_DIR = "/run/duraclaw/sessions"

# Skip eval/research/test projects — these are noise
SKIP_PATTERNS = [
    "eval-projects-",
    "kata-eval",
    "session-research",
    "kata-test",
    "kata-fresh",
]


def default_orchestrator_dir():
    """Resolve <repo>/apps/orchestrator relative to this script.

    Script lives at <repo>/scripts/backfill-d1-sessions.py, so go up one and
    into apps/orchestrator. Works across worktrees without env vars.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)
    return os.path.join(repo_root, "apps", "orchestrator")


def parse_args():
    ap = argparse.ArgumentParser(
        description="Backfill agent_sessions in D1 from ~/.claude/projects."
    )
    ap.add_argument(
        "--user-id",
        default=os.environ.get("DURACLAW_BACKFILL_USER_ID"),
        help="Owning user_id stamped on every row (or $DURACLAW_BACKFILL_USER_ID).",
    )
    ap.add_argument("--dry-run", action="store_true", help="Print SQL only.")
    ap.add_argument(
        "--gateway-dir",
        default=os.environ.get("GATEWAY_DIR", DEFAULT_GATEWAY_DIR),
        help="Gateway sessions dir (default %(default)s).",
    )
    ap.add_argument(
        "--orchestrator-dir",
        default=default_orchestrator_dir(),
        help="Directory with wrangler.jsonc (default: <repo>/apps/orchestrator).",
    )
    ap.add_argument(
        "--use-wrangler-auth",
        action="store_true",
        help="Strip CLOUDFLARE_* env vars so wrangler uses its stored creds.",
    )
    args = ap.parse_args()
    # User id is required unless dry-run.
    if not args.dry_run and not args.user_id:
        ap.error("--user-id is required (or set $DURACLAW_BACKFILL_USER_ID) unless --dry-run")
    return args


def dir_to_project(dirname):
    """Convert .claude/projects dir name to project name.
    e.g. '-data-projects-duraclaw-dev1' -> 'duraclaw-dev1'
    """
    # Strip leading -data-projects-
    name = dirname
    if name.startswith("-data-projects-"):
        name = name[len("-data-projects-"):]
    elif name.startswith("-tmp-"):
        return None  # skip /tmp dirs
    return name


def extract_jsonl_metadata(path):
    """Extract session metadata from a JSONL file."""
    meta = {
        "turns": 0,
        "first_ts": None,
        "last_ts": None,
        "model": None,
        "prompt": None,
        "cwd": None,
        "branch": None,
    }

    try:
        with open(path, "r") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                ts = obj.get("timestamp")
                if ts and not meta["first_ts"]:
                    meta["first_ts"] = ts
                if ts:
                    meta["last_ts"] = ts

                t = obj.get("type")
                if t == "system":
                    meta["cwd"] = obj.get("cwd")
                    meta["branch"] = obj.get("gitBranch")
                elif t == "user":
                    meta["turns"] += 1
                    if not meta["prompt"] and not obj.get("isMeta", False):
                        # JSONL stores content in obj.message.content (not obj.content)
                        msg = obj.get("message", {})
                        content = msg.get("content", "") or obj.get("content", "")
                        if isinstance(content, list):
                            for c in content:
                                if isinstance(c, dict) and c.get("type") == "text":
                                    text = c.get("text", "")
                                    if text and not text.startswith("<"):
                                        meta["prompt"] = text[:500]
                                        break
                        elif isinstance(content, str) and content and not content.startswith("<"):
                            meta["prompt"] = content[:500]
                elif t == "assistant":
                    if not meta["model"]:
                        msg = obj.get("message", {})
                        meta["model"] = msg.get("model") or obj.get("model")
    except Exception as e:
        print(f"  WARN: failed to read {path}: {e}", file=sys.stderr)

    return meta


def load_gateway_data(gateway_dir):
    """Load gateway .cmd + .meta.json files, keyed by sdk_session_id."""
    gateway = {}

    cmd_files = glob.glob(os.path.join(gateway_dir, "*.cmd"))
    meta_files = glob.glob(os.path.join(gateway_dir, "*.meta.json"))

    cmds = {}
    for f in cmd_files:
        sid = os.path.basename(f).replace(".cmd", "")
        try:
            with open(f) as fh:
                cmds[sid] = json.load(fh)
        except:
            pass

    for f in meta_files:
        sid = os.path.basename(f).replace(".meta.json", "")
        try:
            with open(f) as fh:
                meta = json.load(fh)
                sdk_id = meta.get("sdk_session_id")
                if sdk_id:
                    gateway[sdk_id] = {
                        "gateway_id": sid,
                        "cost_usd": meta.get("cost", {}).get("usd", 0),
                        "model": meta.get("model"),
                        "turn_count": meta.get("turn_count", 0),
                        "state": meta.get("state"),
                        "project": cmds.get(sid, {}).get("project"),
                    }
        except:
            pass

    return gateway


def escape_sql(s):
    """Escape a string for SQL insertion."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def main():
    args = parse_args()
    print("=== Duraclaw D1 Session Backfill ===\n")

    # 1. Load gateway data (keyed by sdk_session_id)
    gateway = load_gateway_data(args.gateway_dir)
    print(f"Gateway sessions loaded: {len(gateway)} (from {args.gateway_dir})")

    # 2. Scan all JSONL files
    project_dirs = glob.glob(os.path.join(CLAUDE_PROJECTS, "-data-projects-*"))
    project_dirs.sort()

    sessions = []
    skipped = 0

    for pdir in project_dirs:
        dirname = os.path.basename(pdir)
        project = dir_to_project(dirname)
        if not project:
            continue

        # Skip eval/research dirs
        if any(pat in dirname for pat in SKIP_PATTERNS):
            skip_count = len(glob.glob(os.path.join(pdir, "*.jsonl")))
            skipped += skip_count
            continue

        jsonls = glob.glob(os.path.join(pdir, "*.jsonl"))
        if not jsonls:
            continue

        print(f"\n  {project}: {len(jsonls)} sessions")

        for jpath in sorted(jsonls):
            sdk_session_id = os.path.basename(jpath).replace(".jsonl", "")

            # Extract from JSONL
            meta = extract_jsonl_metadata(jpath)

            # Merge gateway data if available
            gw = gateway.get(sdk_session_id, {})

            # Determine status
            gw_state = gw.get("state")
            if gw_state == "running":
                status = "running"
            elif meta["turns"] == 0:
                status = "idle"
            else:
                status = "idle"

            # Determine project (gateway overrides JSONL dir if available)
            final_project = gw.get("project") or project

            # Build row
            row = {
                "id": sdk_session_id,
                "user_id": args.user_id or "DRY_RUN_USER",
                "project": final_project,
                "status": status,
                "model": gw.get("model") or meta["model"],
                "sdk_session_id": sdk_session_id,
                "created_at": meta["first_ts"] or datetime.now().isoformat(),
                "updated_at": meta["last_ts"] or datetime.now().isoformat(),
                "last_activity": meta["last_ts"],
                "num_turns": meta["turns"],
                "prompt": meta["prompt"],
                "summary": None,
                "title": None,
                "tag": None,
                "origin": "backfill",
                "agent": "claude",
                "archived": 0,
                "duration_ms": None,
                "total_cost_usd": gw.get("cost_usd") if gw.get("cost_usd") else None,
                "message_count": meta["turns"],
                "kata_mode": None,
                "kata_issue": None,
                "kata_phase": None,
            }

            sessions.append(row)

    print(f"\n\nTotal sessions to backfill: {len(sessions)}")
    print(f"Skipped (eval/research): {skipped}")

    if not sessions:
        print("Nothing to do.")
        return

    # 3. Generate SQL in batches (D1 has query size limits)
    BATCH_SIZE = 25
    columns = [
        "id", "user_id", "project", "status", "model", "sdk_session_id",
        "created_at", "updated_at", "last_activity", "num_turns", "prompt",
        "summary", "title", "tag", "origin", "agent", "archived",
        "duration_ms", "total_cost_usd", "message_count",
        "kata_mode", "kata_issue", "kata_phase",
    ]

    batches = []
    for i in range(0, len(sessions), BATCH_SIZE):
        batch = sessions[i:i + BATCH_SIZE]
        values_list = []
        for row in batch:
            vals = []
            for col in columns:
                v = row[col]
                if v is None:
                    vals.append("NULL")
                elif isinstance(v, (int, float)):
                    vals.append(str(v))
                else:
                    vals.append(escape_sql(v))
            values_list.append(f"({', '.join(vals)})")

        sql = f"INSERT OR REPLACE INTO agent_sessions ({', '.join(columns)}) VALUES\n"
        sql += ",\n".join(values_list) + ";"
        batches.append(sql)

    print(f"Generated {len(batches)} SQL batches")

    if args.dry_run:
        print("\n--- DRY RUN: SQL preview (first batch) ---")
        print(batches[0][:2000])
        if len(batches) > 1:
            print(f"\n... and {len(batches) - 1} more batches")
        return

    # 4. Execute via wrangler from the orchestrator worktree.
    os.chdir(args.orchestrator_dir)
    if args.use_wrangler_auth:
        # Drop CF creds from env so wrangler falls back to its stored login
        # (useful when the current shell is authed to a different account).
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")}
    else:
        env = os.environ.copy()
    total_inserted = 0
    for i, sql in enumerate(batches):
        print(f"\n  Executing batch {i+1}/{len(batches)}...", end=" ", flush=True)
        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "duraclaw-auth", "--remote",
             "--command", sql],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if result.returncode != 0:
            print(f"FAILED")
            print(f"  stderr: {result.stderr[-500:]}")
            # Try to continue with remaining batches
        else:
            batch_size = min(BATCH_SIZE, len(sessions) - i * BATCH_SIZE)
            total_inserted += batch_size
            print(f"OK ({batch_size} rows)")

    print(f"\n=== Done: {total_inserted} sessions inserted into D1 ===")


if __name__ == "__main__":
    main()

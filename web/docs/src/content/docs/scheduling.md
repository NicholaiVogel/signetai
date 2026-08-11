---
title: "Scheduled Tasks"
description: "Schedule recurring local harness prompts through the daemon."
---

Scheduled tasks are daemon-owned cron jobs. A task stores a prompt, cron expression, harness, optional working directory, and optional skill settings; the daemon starts the configured local harness when it becomes due.

## Create a task

Use the Dashboard Tasks surface or `POST /api/tasks`:

```bash
curl -X POST http://127.0.0.1:3850/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily repository check",
    "prompt": "Run the repository health check and report only actionable failures.",
    "cronExpression": "0 9 * * *",
    "harness": "codex",
    "workingDirectory": "/home/user/project"
  }'
```

Required fields are `name`, `prompt`, `cronExpression`, and `harness`. Current task harnesses are `claude-code`, `codex`, and `opencode`.

Cron expressions use five fields: `minute hour day-of-month month day-of-week`.

## Execution behavior

- The scheduler polls for due tasks every 15 seconds.
- It runs at most three tasks concurrently.
- Each run receives an id and records captured output and terminal status.
- Default runtime limit is 10 minutes.
- Output is bounded to 1,048,576 characters.
- A task already running is not started again.
- On daemon startup, pending and running task records are marked failed with `daemon_restart` so they cannot block the next run.

The spawned commands are intentionally non-interactive:

| Harness     | Invocation shape                                    |
| ----------- | --------------------------------------------------- |
| Claude Code | `claude --dangerously-skip-permissions -p <prompt>` |
| Codex       | `codex exec --skip-git-repo-check --json <prompt>`  |
| OpenCode    | `opencode run --format json <prompt>`               |

The daemon verifies the harness binary is on `PATH`, removes `CLAUDECODE`, and sets `SIGNET_NO_HOOKS=1` for the child to prevent recursive hook activity. On timeout it sends termination and makes a second termination attempt five seconds later. Do not rely on task runs to clean up external work started by a prompt.

## Observe and operate

```bash
# List tasks
curl -fsS http://127.0.0.1:3850/api/tasks

# Inspect a task and recent runs
curl -fsS http://127.0.0.1:3850/api/tasks/<id>

# Trigger a run now
curl -fsS -X POST http://127.0.0.1:3850/api/tasks/<id>/run

# Disable a task
curl -fsS -X PATCH http://127.0.0.1:3850/api/tasks/<id> \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

`GET /api/tasks/:id/stream` provides an SSE stream for the currently running task. `GET /api/tasks/:id/runs` returns run history with pagination.

## Security and safety

Tasks run with the daemon's operating-system permissions. Claude Code tasks use its non-interactive permission bypass. Treat the prompt, working directory, installed harness, and daemon environment as part of the execution boundary.

Use an explicit working directory, a narrow prompt, and a named task. Do not schedule commands that require secrets in prompts or expect a human approval dialog. Prefer a connector, secret-managed service account, or an operator-run workflow for privileged external actions.

## Troubleshooting

1. Check `signet daemon status --json` and task `enabled` state.
2. Check the exact harness binary is on the daemon's `PATH`.
3. Inspect the task's most recent run output and error.
4. Confirm the working directory exists and the daemon user can access it.
5. Verify the cron expression against the intended machine timezone.

Related: [Daemon](/daemon/), [Diagnostics](/diagnostics/), [Secrets](/secrets/).

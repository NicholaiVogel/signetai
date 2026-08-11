---
title: "Your first session"
description: "Save and retrieve memory, manage secrets and skills, and inspect the local daemon."
---

After setup, Signet can store explicit memories, retrieve scoped context, run selected harness integrations, and expose a local dashboard. Background inference and Dreaming are optional; choosing `none` during setup leaves explicit memory commands available.

## Check status and open the dashboard

```bash
signet status
signet dashboard
```

`signet dashboard` starts the configured local daemon if needed. It opens the dashboard in your browser; a workspace configured with `daemon.url` uses that remote daemon instead.

## Save a memory

```bash
signet remember "Use Bun for this project"
signet remember "Never commit credentials" --critical
signet remember "The dashboard work is in progress" --tags project,dashboard
```

`--critical` pins a memory. `--tags` accepts comma-separated tags. Use `--agent <name>` only when you intentionally need to associate the write with a named agent.

Connected harnesses may also expose their own remember command or tool. Use the integration documentation for the exact harness surface instead of assuming a slash command exists everywhere.

## Recall memory

```bash
signet recall "What package manager does this project use?"
signet recall "architecture decisions" --type decision --limit 5
```

Recall supports query, type, tag, agent, time, importance, and score filters. See [Memory and search commands](/cli/memory-search/) for the full reference.

## Store secrets without placing values in prompts

```bash
signet secret put OPENAI_API_KEY
signet secret list
signet secret delete OPENAI_API_KEY
```

The CLI prompts for a secret value rather than echoing it. Treat secret names as less sensitive than values, but do not put values in shell history, source files, screenshots, or documentation.

## Inspect the daemon

```bash
signet daemon status
signet daemon logs -n 100
signet daemon restart
```

Use `signet daemon start` and `signet daemon stop` for explicit lifecycle control. See [Operate your installation](/getting-started/operate/) for update and troubleshooting steps.

## Use skills

```bash
signet skill list
signet skill search browser
signet skill install browser-use
signet skill remove browser-use
```

Skills are instruction packages. Read their source and any required configuration before enabling a skill that can take external actions.

## Next steps

- [Authentication](/auth/) for team or remote access.
- [Sources](/sources/) for files, repositories, URLs, and connected source evidence.
- [Memory lifecycle](/memory/) for retention, recall, and Dreaming.
- [CLI reference](/cli/) for automation and command details.

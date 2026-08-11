---
title: "Memory Skills"
description: "Use Signet memory skills and their CLI equivalents."
---

Signet's memory skills provide agent-facing instructions for storing and recalling durable context. The corresponding CLI commands are `signet remember` and `signet recall`; both call the daemon's memory API.

## Remember

```bash
signet remember "The project uses Bun for package scripts"
signet remember "Never put credentials in public issue bodies" --critical
signet remember "Use the release checklist" -t release,workflow
```

Harnesses that expose the installed skills can provide equivalent `/remember` usage. Use it for durable facts, preferences, and decisions, not transient task progress.

## Recall

```bash
signet recall "package manager preference"
signet recall "release workflow" -l 5 --type decision --tags workflow
signet recall "what did we decide about migrations?" --aggregate --aggregate-budget small
```

Recall accepts a natural-language query and optional filters. An aggregate recall synthesizes from bounded retrieved evidence; use `--no-save-aggregate` when that synthesis should not become a normal memory row.

## Diagnostic posture

When recall or storage behaves unexpectedly, first check daemon availability and then use the narrowest relevant command:

```bash
signet status
signet recall "a known fact" --json
```

The exact skill files and harness exposure differ by installation. Use `signet skill list` and `signet skill show <name>` to inspect the skills actually installed in the current workspace.

---
title: "Skills"
description: "Install, inspect, search, and remove agent skills."
---

Skills are directories under `$SIGNET_WORKSPACE/skills/` with a `SKILL.md` instruction file. A harness can surface installed skills to an agent, but the skill remains instructions: it does not grant commands or permissions by itself.

## CLI commands

The current `signet skill` command set is intentionally small:

```bash
# List installed skills
signet skill list

# Search installed skills and the registry
signet skill search browser

# Install a registry entry or an owner/repository reference
signet skill install owner/repository

# Print an installed SKILL.md
signet skill show browser-use

# Remove an installed skill
signet skill uninstall browser-use
# `remove` is an alias for `uninstall`
```

`info`, `update`, `create`, and `publish` are not registered Signet CLI commands. Create or edit a local skill directory with your normal editor and publish it through the registry or repository workflow that owns it, rather than treating those retired commands as supported Signet behavior.

## Install and search behavior

When the daemon is available, list, show, install, and remove use its skills API. When the daemon is unavailable, the CLI can list local directories, show local `SKILL.md` files, install through the configured skills runner, and search local plus public registry results. Registry results are discovery aids: inspect the source before installing an unfamiliar skill.

```text
$SIGNET_WORKSPACE/skills/
└── release-notes/
    └── SKILL.md
```

## SKILL.md shape

A skill is ordinary Markdown with optional YAML frontmatter. Keep the frontmatter truthful and the body specific about when to use the skill, expected inputs, boundaries, and verification.

```markdown
---
name: release-notes
description: Draft release notes from merged pull requests.
version: 0.1.0
user_invocable: true
arg_hint: "<release range>"
---

# Release notes

Use when the caller asks for release-note drafting.
```

## Safety

Skills can contain untrusted instructions. Install only sources you trust, review a skill before use, and do not treat a skill as authorization to access secrets, alter accounts, or run destructive commands.

For memory-specific skills, see [Memory skills](/memory-skills/).

---
title: "Install"
description: "Install the Signet CLI and choose an interactive or headless setup route."
---

## Choose one installation method

For macOS and Linux, the native installer is the recommended route:

```bash
curl -fsSL https://signetai.sh/install.sh | bash
```

Package-manager wrappers install the same compiled Signet runtime:

```bash
npm install -g signetai
# or
bun add -g signetai
```

Use one method per machine. The npm and Bun routes require their corresponding runtime; the direct installer does not install Bun or rebuild Signet. Windows currently uses the npm route:

```bash
npm install -g signetai
```

Confirm that the launcher is available, then start onboarding:

```bash
signet --help
signet setup
```

If more than one launcher is installed, `signet doctor` reports the conflict. Do not remove a package solely to remove its `signet` launcher: it may also provide `signet-mcp`.

## Recommended first route

Use the interactive wizard unless a deployment system already knows the choices. It can create a workspace, configure selected harnesses, initialize the database, and start a local daemon. Continue with [Set up Signet](/getting-started/setup/).

## Headless setup

`signet setup` refuses to prompt when standard input is not a TTY. For automation, use either `--non-interactive` with flags or a validated setup plan through `--file` or `--json`.

This example creates a managed Minimal identity, uses the local daemon, uses built-in embeddings, and disables background inference explicitly:

```bash
signet setup --non-interactive \
  --name "My Agent" \
  --identity-mode managed \
  --identity-preset minimal \
  --network-mode localhost \
  --harness claude-code \
  --embedding-provider native \
  --extraction-provider none
```

`--deployment-type local|vps|server` only adjusts inferred defaults for non-interactive setup and reconfiguration. It is not an interactive wizard question. Explicit provider flags take precedence over those inferred defaults.

For a remote daemon, use `--remote-url` with a bare `http://` or `https://` origin. Setup records the remote URL and does not start a local daemon:

```bash
signet setup --non-interactive \
  --name "Remote Agent" \
  --identity-mode off \
  --remote-url https://signet.example.test:3850 \
  --embedding-provider none \
  --extraction-provider none
```

Run `signet setup --help` in the installed version before automating a new release. The full flag reference, setup-plan schema, OpenClaw backup flags, roster flags, source flags, and Dreaming option are in [Install and configure](/cli/getting-started/).

## Provider choices

Use the values accepted by setup validation:

- Embeddings: `native`, `ollama`, `openai`, or `none`.
- Background inference: `acpx`, `claude-code`, `codex`, `llama-cpp`, `ollama`, `opencode`, `openrouter`, `openai-compatible`, or `none`.

Current CLI help also advertises `llama-cpp` for `--embedding-provider`, but the setup validator does not currently accept it. Use one of the validated embedding values above until that implementation discrepancy is resolved.

## Installation is separate from development

These commands install a product release. To build Signet from source or contribute changes, use [Contributing](/contributing/).

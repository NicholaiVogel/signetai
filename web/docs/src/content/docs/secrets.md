---
title: "Secrets"
description: "Store and use sensitive values without writing them into configuration or prompts."
---

Signet secrets are daemon-managed encrypted values. The CLI and API deliberately expose names and status, not raw stored values.

## Basic commands

```bash
# Prompt for a value without echoing it
signet secret put OPENAI_API_KEY

# Names only
signet secret list
signet secret has OPENAI_API_KEY

# Confirmation is required
signet secret delete OPENAI_API_KEY
```

Use a stored value from `agent.yaml` by reference:

```yaml
embedding:
  api_key: $secret:OPENAI_API_KEY
```

Do not place provider keys directly in YAML, shell history, screenshots, task prompts, or source control.

## Use a secret in a command

`signet secret exec` queues a command with selected secrets injected into the child environment. The command must name each injected secret before the command token:

```bash
signet secret exec --secret OPENAI_API_KEY \
  curl https://api.openai.com/v1/models
```

The CLI returns a job id. Inspect it with:

```bash
signet secret exec-status <job-id>
```

The command line is constructed so shell-level secret expansion is not used. Treat the child process, its output, and its working directory as sensitive anyway: a process that can read an injected environment variable can disclose it.

## External providers

The current CLI supports 1Password and Bitwarden integrations in addition to the local encrypted provider.

```bash
# 1Password service-account flow
signet secret onepassword connect
signet secret onepassword status
signet secret onepassword vaults

# Bitwarden session flow
bw unlock --raw | signet secret bitwarden connect --session-stdin
signet secret bitwarden status
signet secret bitwarden use local
signet secret bitwarden use bitwarden
```

Use an integration only when its access boundary matches the deployment. Keep its service token or session token out of process arguments and committed files.

## Storage and recovery

Local secret state is kept under `$SIGNET_WORKSPACE/.secrets/`. Keep this directory private and out of source control. Secret values are intentionally not available through a `get` command; `signet secret get NAME` explains how to use an existing reference instead.

Moving a workspace to a different machine or restoring it from backup is a security-sensitive operation. Verify the recovered secret provider state before restarting automation. Do not hand-copy ciphertext or reset secret files to troubleshoot a provider issue.

## API boundary

The daemon exposes list, store, delete, execution, and external-provider status routes under `/api/secrets`. These routes are permission-protected in authenticated deployments. Use the CLI for ordinary operation and the [HTTP API](/api/) when building a controlled integration.

Related: [Authentication](/auth/), [Self-Hosting](/self-hosting/), [Remote Harness Connectors](/remote-connectors/).

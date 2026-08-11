---
title: "Operate your installation"
description: "Run, update, move, secure, and troubleshoot a Signet installation."
---

## Daemon lifecycle

Use the CLI lifecycle commands for normal local operation:

```bash
signet daemon start
signet daemon status
signet daemon logs -n 100
signet daemon restart
signet daemon stop
```

`signet dashboard` also starts the configured local daemon when necessary. The top-level `signet start`, `signet stop`, `signet restart`, and `signet logs` commands remain aliases, but the `signet daemon` group is the preferred interface.

On systems with a user service manager, the CLI can use its runtime integration to supervise a daemon process. Do not assume that a source-checkout-only `bun run install:service` workflow exists in a globally installed release. Use the commands above unless you are deliberately operating a source checkout.

## Update safely

```bash
signet update check
signet update install
signet daemon restart
```

`signet update install` updates the launcher it owns. Restart the daemon after an update so the running process uses the new version. `signet doctor` can diagnose an installation conflict or local health problem.

## Workspace location

Inspect the active workspace before moving or automating it:

```bash
signet workspace status
signet workspace set /path/to/workspace
signet daemon restart
```

`workspace set` persists the selected path for CLI, connector, and desktop resolution and can migrate workspace files. A running daemon does not automatically adopt that persisted selection; restart it after a workspace change. See [CLI environment and exit codes](/cli/environment/#workspace-resolution) for the current surface-by-surface behavior.

## Local and remote access

A new local installation binds to localhost and uses local auth mode. For Tailscale or team access, configure the network/auth settings deliberately and then restart the daemon. Do not expose a local-mode daemon on a shared network. See [Authentication](/auth/) for the team-server bootstrap and [Self-hosting](/self-hosting/) for deployment context.

## Troubleshoot

```bash
signet doctor
signet status
signet daemon logs --level warn
curl -fsS http://127.0.0.1:3850/health
```

If the daemon is not reachable, start it explicitly with `signet daemon start`. If a workspace variable or persisted workspace path points somewhere unexpected, inspect `signet workspace status` before deleting files or creating a new installation. For a remote daemon, also check `SIGNET_DAEMON_URL` and the configured `daemon.url` before assuming local lifecycle commands apply.

## Next steps

- [CLI operations](/cli/operations/) for runtime command details.
- [Authentication](/auth/) for protected team deployments.
- [CLI environment and exit codes](/cli/environment/) for service and automation variables.
- [Diagnostics](/diagnostics/) for health and repair guidance.

---
title: "Configuration"
description: "Operator configuration for a Signet workspace and daemon."
---

Signet reads workspace configuration from `agent.yaml`. Start with `signet setup`, keep credentials in [Secrets](/secrets/), and restart the daemon after an operational change:

```bash
signet daemon restart
signet daemon status --json
```

The running daemon is the authority for operational state. Use [Diagnostics](/diagnostics/) and `/health/ready` to verify a change rather than assuming a YAML edit was applied.

## In this section

- [Workspace and identity](/configuration/workspace-identity/): workspace selection, identity files, embeddings, and safe configuration shape.
- [Inference and routing](/configuration/inference-routing/): canonical targets, policies, workloads, and routes.
- [Pipeline configuration](/configuration/pipeline/): runtime controls, maintenance, documents, continuity, and telemetry.
- [Security and lifecycle](/configuration/security-lifecycle/): authentication, lifecycle behavior, and environment overrides.
- [Files and integrations](/configuration/files-integrations/): managed workspace files, local state, harnesses, and source control.

## Operator rule

Do not restore retired configuration blocks from old examples. In particular, `memory.synthesis` is rejected by the current loader. Keep model selection in the canonical inference routing configuration, and use the current daemon error or [Upgrading](/upgrading/) when an older workspace no longer loads.

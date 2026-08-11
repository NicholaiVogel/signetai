---
title: "Interfaces and agents"
description: "Runtime boundaries and agent-scoped access."
---

The daemon is Signet's public runtime boundary. It exposes HTTP APIs used by the CLI, dashboard, harness integrations, SDK clients, and MCP server. The complete public API inventory belongs in [HTTP API reference](/api/), not in this architecture page.

## Agent scope

User data is scoped by agent identity and, where supported, visibility, project, and explicit scope. Routes resolve an agent identity before reads or writes. Recall and graph traversal authorize candidates before they become content-bearing results; ontology operations reject unauthorized cross-agent targets.

Multiple agents can share a daemon and database without becoming one global memory pile. Read policy controls isolated, shared, or group visibility. Agent-specific workspace identity files can override root files where the configured integration supports them.

## Interface roles

- The daemon owns HTTP contracts, background runtime, authorization, and canonical writes.
- The CLI operates local installation, configuration, and user workflows.
- The React dashboard is a client of daemon routes.
- Harness integrations connect lifecycle events and tools to daemon APIs.
- The SDK and MCP surfaces expose supported client interfaces.

For package ownership and data flow, see [Packages and data flow](/architecture/packages-data-flow/). For routes and request schemas, see [HTTP API reference](/api/).
---
title: "SDK"
description: "Typed TypeScript client for the Signet daemon."
---

`@signet/sdk` is the typed HTTP client for the Signet daemon. It has no SQLite dependency and exports four public entry points:

| Import | Surface |
|---|---|
| `@signet/sdk` | `SignetClient`, errors, and public types |
| `@signet/sdk/react` | React provider and memory hooks |
| `@signet/sdk/ai-sdk` | Vercel AI SDK adapters |
| `@signet/sdk/openai` | OpenAI function-tool adapters |

```bash
bun add @signet/sdk
# or
npm install @signet/sdk
```

## In this section

- [SDK quickstart](/sdk/getting-started/): construct the client and make a first memory call.
- [Core client](/sdk/core-client/): memory operations, auth, and queued secret execution.
- [SDK integrations](/sdk/integrations/): React, AI SDK, OpenAI, lifecycle hooks, and connectors.
- [Operations SDK](/sdk/operations/): plugins, skills, telemetry, repair, configuration, and embeddings.
- [Knowledge and agents](/sdk/knowledge-agents/): knowledge graph and cross-agent coordination.
- [Helpers, types, and migration](/sdk/types-migration/): supported helpers, exported types, errors, and version guidance.

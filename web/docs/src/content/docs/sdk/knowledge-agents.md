---
title: "Knowledge and agents"
description: "Query the knowledge graph and coordinate scoped agent sessions."
---

## Knowledge graph

The current SDK methods use explicit knowledge names:

```typescript
const entities = await client.listKnowledgeEntities({ query: "Signet", limit: 20, agentId: "research" });
const entity = await client.getKnowledgeEntity("entity-id", { agentId: "research" });
const aspects = await client.getEntityAspects("entity-id", { agentId: "research" });
const attributes = await client.getAspectAttributes("entity-id", "aspect-id", {
  agentId: "research",
  kind: "attribute",
  status: "active",
});
const dependencies = await client.getEntityDependencies("entity-id", { agentId: "research" });
const pinned = await client.getPinnedEntities({ agentId: "research" });
```

Other available read operations are `getKnowledgeStats()`, `getTraversalStatus()`, and `getConstellation()`. Pinning is agent-scoped:

```typescript
await client.pinEntity("entity-id", { agentId: "research" });
await client.unpinEntity("entity-id", { agentId: "research" });
```

Do not use retired names such as `listEntities`, `getEntity`, or `listPinnedEntities` for the SDK client.

## Cross-agent coordination

```typescript
const presence = await client.listAgentPresence({ project: "/workspace/app", includeSelf: false });
const sent = await client.sendAgentMessage({
  toAgentId: "reviewer",
  type: "question",
  content: "Can you review the migration boundary?",
});
const inbox = await client.listAgentMessages({ agentId: "reviewer", unreadOnly: true, limit: 25 });
await client.acknowledgeAgentMessage(inbox.items[0].id, { agentId: "reviewer" });
```

`sendAgentMessage` supports a local delivery path and an optional ACP relay. An indeterminate ACP message can be retried with `retryAgentMessage(messageId, { agentId })`; delivery remains agent-scoped.

## Predictor APIs are retired

Predictor methods remain as deprecated SDK tombstones only for clear migration failures. They throw an error stating that predictor APIs were removed in v0.112. Do not call or build new integrations around predictor training, comparisons, or status methods. Use memory-search telemetry and pipeline diagnostics instead.

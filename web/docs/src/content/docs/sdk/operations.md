---
title: "Operations SDK"
description: "Use the current SDK operations for plugins, skills, analytics, repair, and runtime status."
---

## Plugins and skills

```typescript
const plugins = await client.listPlugins();
const diagnostics = await client.getPluginDiagnostics("signet.secrets");
const audit = await client.listPluginAuditEvents({ pluginId: "signet.secrets", limit: 20 });

const installed = await client.listSkills();
const browse = await client.browseSkills();
const search = await client.searchSkills("git");
const skill = await client.getSkill("recall");
await client.installSkill("owner/repository");
await client.uninstallSkill("owner/repository");
```

`browseSkills()` takes no arguments. `installSkill(name, source?)` and `getSkill(name, source?)` take positional arguments, not object payloads.

## Analytics and runtime status

```typescript
const usage = await client.getUsageCounters();
const errors = await client.getErrors({ stage: "mutation", limit: 50 });
const latency = await client.getLatency();
const logs = await client.getAnalyticsLogs({ level: "warn", limit: 50 });
const safety = await client.getMemorySafety();
const continuity = await client.getContinuity({ project: "/workspace/app", limit: 20 });
const pipeline = await client.getPipelineStatus();
const diagnostic = await client.diagnostics("memory");
```

The matching public method names are `getUsageCounters`, `getErrors`, `getLatency`, `getAnalyticsLogs`, `getMemorySafety`, `getContinuity`, and `diagnostics`. Retired documentation names such as `getUsageAnalytics` and `getDiagnostics` are not SDK methods.

## Repair and embeddings

```typescript
await client.requeueDeadJobs();
await client.releaseStaleLeases();
await client.checkFts({ repair: true });
await client.triggerRetentionSweep();
await client.reembedMissing({ limit: 100 });

const embedding = await client.getEmbeddingStatus();
const health = await client.getEmbeddingHealth();
const projection = await client.getEmbeddingProjection({ dimensions: 2 });
```

Repair calls can mutate daemon state. Invoke them deliberately and inspect their typed result. The FTS method is `checkFts({ repair? })`, not `checkFtsConsistency()`.

## Configuration and identity

```typescript
const config = await client.listConfig();
await client.writeConfig("USER.md", "# User");
const identity = await client.getIdentity();
```

These methods are distinct from daemon operator workflows. The SDK does not expose retired `getConfig`, `setConfig`, or `getIdentity({ files })` signatures.

---
title: "Helpers, types, and migration"
description: "Use public helpers, types, error contracts, and current SDK version guidance."
---

## Helpers and errors

`SignetClient` includes helpers such as `waitForJob`, `recallOrThrow`, `getMemoryOrThrow`, `getDocumentOrThrow`, `createAndIngestDocument`, and `batchModifyWithProgress`.

```typescript
import { SignetApiError, SignetClient, SignetNetworkError } from "@signet/sdk";

const client = new SignetClient();
try {
  const result = await client.recallOrThrow("deployment preferences", { limit: 5, minScore: 0.5 });
  console.log(result.results);
} catch (error) {
  if (error instanceof SignetApiError) console.error(error.status, error.body);
  else if (error instanceof SignetNetworkError) console.error("Daemon unavailable");
  else throw error;
}
```

Import public response and record types directly from `@signet/sdk` when a function signature needs them. Use the generated declaration files shipped with the installed SDK as the authoritative type reference for the installed version.

## Version guidance

The published SDK is currently on the 0.x release line. There is no released 1.0 SDK and no blanket 0.x-to-1.0 compatibility promise. Pin and upgrade against a version that exists in the registry, then use TypeScript to identify signature changes:

```bash
bun add @signet/sdk@latest
```

For migration, replace retired method names with the current client surface documented in this section. In particular, predictor APIs were removed in v0.112 and are deprecated methods that throw instead of working runtime endpoints.

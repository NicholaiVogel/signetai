Contributing to Signet
======================

This guide is for contributors to the `signetai` monorepo. For product installation and use, start with the public Quickstart instead.

Development setup
-----------------

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai
bun install
bun run build
```

Read the nearest `AGENTS.md` before changing an area. Current source and executable checks are authoritative; plans and older documents are not proof of shipped behavior.

Before opening a change, run focused checks for the touched package. Before a broad PR, run the repository gates that apply:

```bash
bun run typecheck
bun run lint
bun run format
bun test
```

Project structure
-----------------

```text
platform/      core runtime, daemon, and native bindings
surfaces/      CLI, React dashboard, desktop, and other human-facing clients
integrations/  harness integrations
libs/          reusable libraries
plugins/       Signet-native plugins
dist/          shipping artifacts
web/           public sites and workers
memorybench/   benchmark harness and reports
```

The daemon owns HTTP contracts, authorization, background runtime, and supported writes. `platform/core` owns shared types, SQLite access, migrations, and search. The dashboard is a React client of daemon APIs.

Contribution rules
------------------

- Use Bun, not npm or pnpm.
- Keep changes focused and match the owning package's existing conventions.
- Preserve agent scope, visibility, source provenance, and audit history for data work.
- Treat source artifacts and transcripts as evidence. Derived memories, claims, and indexes must not rewrite their source.
- Use canonical configuration paths. Do not restore retired extraction, synthesis, or fallback configuration readers.
- Update public docs with behavior and API changes. Edit root `CONTRIBUTING.md` and `ROADMAP.md`, then run `bun scripts/sync-root-docs.ts`; do not edit their generated public copies directly.
- Use conventional commits: `type(scope): subject` with a concise imperative subject. Reserve `feat:` for user-facing capabilities.
- Disclose AI assistance as required by [AI_POLICY.md](./AI_POLICY.md).

Pull requests
-------------

Keep one PR to one topic. Explain what changed, why it matches current behavior, what checks ran, and any remaining limitation. UI changes need screenshots. Rebase before landing; do not create merge commits on `main`.

If an architectural direction is unclear, open an issue or discussion rather than presenting a plan as already shipped.

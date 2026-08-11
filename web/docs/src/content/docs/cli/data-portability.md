---
title: "Data and portability commands"
description: "Export, import, migrate, and audit Signet data."
---

## Export and import a portable bundle

```bash
signet export
signet export --json
signet export bundle
signet import ./signet-export
signet import ./signet-export.json --json --conflict merge
```

`signet export` is equivalent to `signet export bundle`. Bundles carry the workspace identity files, `agent.yaml`, memory and ontology data, and installed skills. Import restores a bundle into the selected workspace.

Choose a conflict policy deliberately:

- `skip`: keep existing memories and skip duplicates.
- `overwrite`: replace matching records.
- `merge`: merge compatible records when supported.

Treat an export as sensitive: it can include private identity and memory data. Encrypt it at rest and do not upload it to an untrusted service.

## Export transcripts

```bash
signet export transcripts
signet export transcripts --output ./conversations.jsonl
signet export transcripts --harness hermes-agent --agent ant
signet export transcripts --since 2026-06-01 --until 2026-07-01
signet export transcripts --limit 5000 --offset 5000 --output ./part-2.jsonl
signet export transcripts --messages-only
signet export transcripts --json
```

Transcript export writes JSONL to standard output by default, or to `--output`. Use repeated `--harness` and `--agent` filters, `--limit` and `--offset` for resumable exports, and `--messages-only` to omit system and tool messages. `--json` emits a JSON array instead of JSONL.

Transcripts can contain credentials, personal data, and private project context. Review access controls before using an export for training or analysis.

## Schema and vector migrations

```bash
signet migrate-schema
signet migrate-schema --path /custom/path

signet migrate-vectors --dry-run
signet migrate-vectors --keep-blobs
signet migrate-vectors --remove-zvec
```

Run migrations against a backup and make sure the intended daemon/workspace is selected. `migrate-schema` is designed to be idempotent for supported legacy schemas. `migrate-vectors --dry-run` previews a vector migration before it changes data.

## Audit embedding coverage

```bash
signet embed audit
signet embed audit --json
signet embed backfill --dry-run
signet embed backfill --batch-size 100
signet embed backfill --model-mismatch --dry-run
signet embed backfill --all --dry-run
```

`signet embed audit` is the supported coverage command. It reports total, embedded, missing, and coverage values, and may include staging information. `signet embed gaps` is retired and is not a valid CLI subcommand.

Use `signet embed backfill` to generate missing embeddings. `--model-mismatch` selects vectors with a different stored model or dimension. `--all` re-embeds every active memory and therefore requires either `--dry-run` or `--model-mismatch` as an explicit migration confirmation.

Embedding commands require a reachable daemon. See [Runtime operations](/cli/operations/#daemon-commands) if it is not running.

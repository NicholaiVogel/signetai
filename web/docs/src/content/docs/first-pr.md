---
title: "Your First PR"
description: "A practical first contribution to Signet."
---

This guide assumes you have a GitHub account, Git, Bun, and a code editor. If you are new to Git, start with a small documentation correction or a clearly scoped issue.

## Make a branch

Fork [Signet](https://github.com/Signet-AI/signetai), clone your fork, and add the upstream remote:

```bash
git clone https://github.com/YOUR-USERNAME/signetai.git
cd signetai
git remote add upstream https://github.com/Signet-AI/signetai.git
bun install
git checkout -b docs/short-description
```

Read the root `AGENTS.md` and any nearer instructions for the files you will touch. Do not work directly on `main`.

## Make one focused change

Use current source and tests as the authority for behavior. Keep the PR small enough to explain. For a documentation change, verify the page against the code or public interface it describes instead of copying older prose.

## Verify it

Run the checks that match the changed area. A typical source change uses:

```bash
bun run typecheck
bun run lint
bun run format
bun test
```

For docs, run the docs content validation, check, and build described in the docs package. Fix or clearly report failures before asking for review.

## Commit and open the PR

```bash
git add path/to/file
git commit -m "docs(area): clarify current behavior"
git push origin docs/short-description
```

Open a pull request from your fork. Use the repository template, explain the behavior or source you verified, list the exact checks you ran, and disclose AI assistance where applicable. A maintainer may ask for changes; push follow-up commits to the same branch.

See [Contributing](/contributing/) for project boundaries and conventions.
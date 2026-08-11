---
title: "North Star Ontology"
description: "A future design direction for an artifact-backed operational ontology."
sidebar:
  badge:
    text: "Vision"
    variant: "note"
---

This is design direction, not a description of the shipped runtime. For the current model, read [Knowledge architecture](/knowledge-architecture/) and [Knowledge graph](/knowledge-graph/).

The north star is an artifact-backed operational ontology: preserve source material as evidence, derive observations and claims with lineage, and make current operational views inspectable and reviewable.

## Direction

A future unified model may treat memories, transcripts, documents, and connected sources as artifacts with common provenance and permission boundaries. Interpretations could then produce observations, claim values, proposals, and current views without replacing their artifacts.

The intended separation remains:

```text
evidence artifact -> derived interpretation -> audited current view
```

The proposed upper-level concepts include artifacts, observations, claim slots, claim values, reducers, current views, proposals, questions, actions, and policies. These names describe a target for future design work, not a promise of active reducers, automatic questions, or universal source adapters.

## What exists today

Current Signet already separates evidence from scoped ontology rows and supports audited operations, proposals, versioned claim attributes, dependencies, and epistemic assertions. Dreaming can apply audited semantic operations from bounded episodic evidence. The implementation does not yet provide one universal artifact lifecycle or the complete reducer/current-view system described by this design.

Keep product claims anchored to the current [Knowledge architecture](/knowledge-architecture/). Use this page when evaluating future data-model work.
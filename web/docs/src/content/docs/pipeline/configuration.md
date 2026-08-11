---
title: "Pipeline configuration reference"
description: "Where supported pipeline and inference settings are documented."
---

This page formerly duplicated retired extraction and synthesis configuration. Those fields are rejected by the daemon and should not be added to `agent.yaml`.

Use these canonical references instead:

- [Inference and routing](/configuration/inference-routing/) for model, provider, and workload bindings. Dreaming uses the router's memory-extraction workload for inference.
- [Pipeline configuration](/configuration/pipeline/) for supported `memory.pipelineV2` controls.
- [Security and lifecycle](/configuration/security-lifecycle/) for retention, safety, and operational lifecycle settings.

The active pipeline can run document ingestion, retention, maintenance, synthesis/projection, and optional hints. Dreaming is the sole automatic semantic writer. There is no supported setting that restores the retired extraction, decision, structural, or dependency-synthesis workers.

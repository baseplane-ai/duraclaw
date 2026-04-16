# Deploy Test Marker

This file exists solely to exercise the skip-path in the duraclaw deploy pipeline.
Pushes that only touch planning/**/* should be detected as no-op and the pipeline
should exit after the `detecting` phase with all subsequent phases marked skipped.

Timestamp: 2026-04-16T18:58

---
"@appflare/pack": minor
---

The packer reads a D1 binding's baseline (`resources.d1[binding].baseline`), refuses one that may not run at install before anything is built, writes it to `d1-baseline/<binding>/<path>` in the zip, records it as `d1Baseline`, and writes the artifact as format 5. `verify` holds the stored baseline to the same rule, and the pack summary and CLI output count baselines.

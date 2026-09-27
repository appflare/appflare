---
"@appflare/schema": minor
---

A catalog manifest's `license` still takes any non-empty text, so manifests already stored keep parsing, and its description now names the forms to use: an SPDX license expression (source-available licenses such as `BUSL-1.1` included), `NONE` for a repository that publishes no license, or `SEE LICENSE IN <file>`. `licenseProblem` and `licenseWarning` say when a value is none of these. The new optional `licenseNote` is one short line shown next to the license, and a revision may change it. Index rows can carry `license` and `licenseNote` so catalog cards show the license without reading the manifest.

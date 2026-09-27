---
"@appflare/cf-api": minor
---

A `pipelines` namespace for the Pipelines API of September 2025 on (`/accounts/{id}/pipelines/v1`): list (every page, by `total_count`), create, get and delete streams, sinks and pipelines, and `probeStreams`, a one-row list that tells whether the token and the account can use Pipelines at all. Sinks are R2 Data Catalog sinks (`type: "r2_data_catalog"`, Parquet), whose body carries an API token that, like every body, never appears in an error message or a request log. An `r2Catalog` namespace for R2 Data Catalog (`/accounts/{id}/r2-catalog/{bucket}`): `get` (404 with code 40401, `R2_CATALOG_NOT_FOUND_CODE`, when the bucket has none), `enable`, `remove` (`POST …/delete`, with `force` for its tables' records), `storeCredential` and `updateMaintenance` for compaction and snapshot expiration.

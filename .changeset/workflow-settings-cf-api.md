---
"@appflare/cf-api": patch
---

`WorkflowInfo` now types the `schedules` that `getWorkflow` answers with (each `cron` and its `next_instance`), absent when the Workflow has none, and `WorkflowPutBody` notes that an empty `schedules` list, which Workers Free accepts too, says the Workflow has none.

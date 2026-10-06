---
"@appflare/pack": minor
---

The packer keeps a Workflow's `limits`, `concurrency`, `schedules` and `default_retention` from the wrangler config, recording them in the artifact as `worker.workflowSettings` beside the unchanged binding (`collectWorkflowSettings`), so the manager creates the Workflow with the settings `wrangler deploy` would give it. A field of `limits`, `concurrency` or `default_retention` that wrangler does not know is left out, and the pack log says so (`unknownWorkflowSettingFields`). A pack fails when a binding that runs another Worker's Workflow sets any of them (`WorkflowSettingsError`), as `wrangler deploy` does, and, before building, when a Workflow runs on a schedule and the catalog manifest does not say `"plan": "paid"`. A Workflow binding whose `script_name` is its own Worker's name is now recorded without it in an app of one Worker too, so the manager creates that Workflow instead of refusing the binding.

---
"@appflare/schema": minor
---

An app of several Workers may run a Workflow that another of its Workers defines. A Workflow binding's `script_name` recorded as `{{workerName:<name>}}` now counts as a binding to that Worker (`bindingEntryRefs`), so the Worker that defines the Workflow is deployed first. The artifact checks require that Worker to define a Workflow of the same name and class, and refuse two Workers that define one Workflow. New helpers: `definesWorkflow(binding)` and `upstreamWorkflowName(binding)`.

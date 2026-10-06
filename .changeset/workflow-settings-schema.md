---
"@appflare/schema": minor
---

An artifact Worker may record the settings its wrangler config gives each Workflow it defines, as `worker.workflowSettings` keyed by binding: `limits.steps`, `concurrency.limit`, `schedules` (always a list of cron expressions) and `default_retention` (`success_retention`, `error_retention`, in milliseconds or a duration such as `"3 days"`), with the names and checks wrangler uses (`workflowSettingsSchema`, `WORKFLOW_SETTING_KEYS`). The artifact checks refuse settings recorded for a binding the Worker does not have or for one that runs another Worker's Workflow (`workflowSettingsProblems`), and a Workflow on a schedule unless the catalog manifest says `"plan": "paid"`, since Cloudflare runs scheduled Workflows only on Workers Paid (`scheduledWorkflowPlanProblem`). The artifact format stays 1: a manager from before this field strips it and creates the Workflows with Cloudflare's defaults.

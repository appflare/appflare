---
"@appflare/schema": minor
---

`install.workers` now takes 2 to 24 Workers (`MAX_ENTRY_WORKERS`), up from 5, so apps built as a router with many small Workers can be listed. A longer list is refused with a message naming the limit, and an entry of more than three Workers (`MAX_FREE_PLAN_ENTRY_WORKERS`) must set `"plan": "paid"`, since one job on Workers Free installs at most three. The budgets that bound one install or update job are exported alongside the upload budget: `PAID_PLAN_SUBREQUESTS` (10,000 per Workflow instance by default), `FREE_PLAN_WORKFLOW_STEPS` and `PAID_PLAN_WORKFLOW_STEPS` (1,024 and 10,000 steps), and `FREE_PLAN_ACCOUNT_WORKERS` and `PAID_PLAN_ACCOUNT_WORKERS` (100 and 500 Workers per account).

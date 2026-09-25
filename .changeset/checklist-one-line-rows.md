---
"@appflare/manager": patch
---

Tighten the account checklist on the last setup step and in Settings › Account and capabilities: every row is one line of the same height (status icon, title, a short status, the action on the right), and what each row means moves into a help tooltip beside its title. Optional rows keep the same shape in a quieter style under their own heading. The Zero Trust row says "Configured" and keeps the team domain in its tooltip, action labels are shorter ("Register", "Upgrade", "Open R2"), and starting sandbox builds from the setup wizard shows a small "Enabling…" status with a spinner, linked to the job, instead of a sentence. The status now comes from the enable job itself, so it survives a reload, turns into "Enabled" once the job succeeds, and after a failure the row says "Last try failed" with a link to the job log. The sandbox builds card in Settings shows dashboard links by name instead of printing their addresses.

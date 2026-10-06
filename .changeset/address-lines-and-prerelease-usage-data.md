---
"@appflare/manager": patch
---

The last line of an update or a rollback names the app's address, as an install's does, instead of the health check's URL. In Settings, Building apps, the GitHub access section points at the sandbox builds section above it when sandbox builds are off or need an update, instead of linking to the page it is on. A pre-release of Appflare (a version such as `0.4.0-rc.1`) no longer sends usage data, as a development build already did not, so test managers stay out of the usage numbers: Settings, Usage data says so, and the Worker's log notes the skipped report once.

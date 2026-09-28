---
"@appflare/manager": patch
---

An app without a name of its own now goes by the app's name everywhere: its page, the sidebar, Home, the jobs, notifications, and the install and rename forms ("Leave empty to use the app's name"). Before, some places showed the app's name and others its Worker name, so one app could read as "Sink" in one place and "sink-2" in another. When two apps would read the same, the Worker name follows in parentheses, as in "Sink (sink-2)". Home never shows Worker names; the app's Details still list the Worker.

---
"@appflare/manager": minor
---

When a job fails, admins can send the Appflare team a report so the failure can be fixed. "Send a report" sits on the failure message of the job's page and on the sandbox and Appflare update cards. It opens a dialog that says in plain words what the report contains (what failed, where it stopped, Cloudflare's error codes, the Appflare version and Workers plan, and the job's log), takes an optional note, and shows the exact report on request. Tokens, keys, passwords, email addresses and account ids are taken out of the log, the error and the note before anything leaves. A report goes through the usage-data channel as a `job_failure_report` event, is sent even when usage data is off (the dialog says so, since the admin chose to send it), and each failed job can be reported once; the card then reads "Thanks, report sent".

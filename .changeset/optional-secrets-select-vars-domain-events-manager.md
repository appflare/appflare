---
"@appflare/manager": minor
---

The scheduled run now reads the state of every external domain, with one list of custom hostnames per gateway zone, records it, and sends the new notification events "Domain active" and "Domain failed" once per change: a domain that goes active, fails validation, loses its certificate, or whose custom hostname was deleted in the dashboard. The check runs in an invocation of its own through the manager's `SELF` binding, and asks Cloudflare nothing when there are no external domains. A domain's card also marks a certificate that timed out or expired as a problem.

Optional catalog secrets are left unset on the install form unless the admin turns on "Set now", are never asked for by an update, and can be removed from the app's settings while the installed version still declares them. Catalog vars with a fixed set of values show as choice cards (up to four) or a dropdown, on the install form and in the app's settings, and a value outside the choices is refused; a stored choice a newer version no longer offers falls back to the default with a warning in the job log.

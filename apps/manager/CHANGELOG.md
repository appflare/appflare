# @appflare/manager

## 0.1.0

### Minor Changes

- b2f4d20: Uninstall apps, and install one app more than once.
  
  - **Uninstall**: an install's page has an Uninstall button. The dialog lists the app's data resources (KV namespaces, D1 databases, R2 buckets, queues, Vectorize indexes) with a checkbox each, shows KV key counts and D1 sizes, and asks you to type the Worker name. The uninstall job deletes the Worker (with its routes, cron triggers, secrets, Durable Objects, and Workflows) and every ticked resource, emptying R2 buckets first. Unticked resources stay in the account and are listed on the install's page. If the job stops part way, "Retry uninstall" deletes what is left, and lets you keep anything Cloudflare refuses to delete (such as an R2 bucket with incomplete multipart uploads). Failed installs can be uninstalled the same way; a Worker is only deleted when Appflare created it for that install.
  - **Several instances of an app**: install the same app again under another Worker name; the form suggests the next free one (`cut-2`) and lets you name each install. Apps whose catalog entry sets `install.fixedWorkerName` still install once.
  - The installed apps list shows each install by name and Worker; uninstalled installs are in a collapsed section.

## 0.0.1

### Patch Changes

- 4985115: Initial manager shell

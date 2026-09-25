---
"@appflare/manager": patch
---

Disabling sandbox builds no longer seems to stall for about five minutes. The job now deletes the sandbox Worker, its container applications and the build bucket first, and disconnects Appflare last. That step redeploys Appflare's own Worker, and the job step that ran after it used to hang before its retry succeeded. Enabling and updating also record the job in the step that connects Appflare, so no step runs after that redeploy. Unknown addresses under a page, such as `/apps/<id>/foo` or `/catalog/a/b`, now show a "Page not found" page with a link home instead of "Something went wrong". A new install from a repository no longer lists Containers under "Runs on": the container is where the app was built, and the list now comes from the built Worker's bindings.

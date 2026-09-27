---
"@appflare/schema": minor
---

A Worker of an entry that installs several Workers may set `install.workers[].workersDev: false` to stay off workers.dev: only the entry's other Workers reach it, through their bindings. The primary Worker cannot set it, since its workers.dev URL is the app's address and health check until a custom domain takes over, and `{{workerUrl:<name>}}` naming such a Worker in `postInstall` or a var's default is refused. An artifact whose entry keeps a Worker off workers.dev is format 4, so managers that read only formats 1 to 3 refuse it instead of putting that Worker on a public URL. `AppWorker.workersDev` and `entryWorkerOnWorkersDev()` tell whether a Worker answers on workers.dev, and `entryPlaceholderValues()` gives such a Worker no URL.

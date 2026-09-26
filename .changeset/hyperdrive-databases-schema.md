---
"@appflare/schema": minor
---

Catalog manifests can declare databases that live outside Cloudflare. `resources.hyperdrive` lists each Hyperdrive binding of the app's wrangler config with the protocol behind it, `{ "binding": "HYPERDRIVE", "protocol": "postgres" | "mysql", "label"?, "help"? }`; a binding may be declared once, and self-deploying entries cannot declare any. `parseConnectionString` reads a `postgres://`, `postgresql://` or `mysql://` URL into the origin Hyperdrive takes (host, port defaulting to 5432 or 3306, user, password, database) and explains a problem without repeating any part of the string; `connectionStringProblems` and `hyperdriveDeclarationProblems` check entered strings and a Worker's bindings against the declarations. The services worked out for an app include Hyperdrive from these declarations alone, so sandbox tier entries show it before they are built.

`install.wranglerConfig` may name a config kept as a template, such as `wrangler.toml.example` or `wrangler.jsonc.template`; `wranglerConfigFromTemplate` gives the real name it is copied to.

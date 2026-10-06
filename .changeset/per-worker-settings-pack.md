---
"@appflare/pack": minor
---

The packer keeps `props` on a service binding to the app's own Worker or to another Worker of its entry, as `wrangler deploy` sends them, and checks the placeholders in their strings like a var's (`servicePropsPlaceholderProblems`); props that are not a JSON object are refused. A config patch can set vars to text and add a Workers AI binding.

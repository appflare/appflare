---
"@appflare/manager": patch
---

After a disable deletes the sandbox Worker but stops before disconnecting Appflare, the binding it leaves behind now reads as off everywhere, not only on Settings > Building apps. Before this, Your account's "What this account can run", the catalog and the app pages still showed sandbox builds as on, so an install form left out the note that sandbox builds would be turned on first, and Settings > GitHub access offered to add a token that could not be stored. Appflare now records the deleted sandbox Worker when the disable deletes it, and also when any check finds the binding pointing at nothing (which covers a disable left unfinished before this version). It clears the record when connecting, enabling, disabling or updating Appflare finishes, or when the sandbox Worker answers again.

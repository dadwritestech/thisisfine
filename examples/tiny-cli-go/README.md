# notes

A tiny Go cli with no dependencies, used by the thisisfine walkthrough and end-to-end test.

It ships with a bug on purpose: `notes add "buy milk" --dry-run` writes the note anyway. Ask Claude to make `--dry-run` write nothing, say `y` when thisisfine asks you to lock it, then ask for "a refactor of the argument parsing" and see what happens.

```bash
go run ./cmd/notes add "buy milk" --dry-run
```

`thisisfine init` finds `cmd/notes` on its own and writes:

```json
{ "build": "go build -o .thisisfine/bin/notes{exe} ./cmd/notes", "cli": "{app}/.thisisfine/bin/notes{exe}" }
```

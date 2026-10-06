# thisisfine for pi

The same promises, the same ledger and the same CLI as the Claude Code plugin, driven by a [pi](https://github.com/earendil-works/pi) extension. The extension holds no logic of its own: it turns pi's events into `thisisfine hook-*` calls (with `"agent": "pi"` in the JSON) and the answer back into pi actions. A project can use Claude Code and pi side by side.

## Install

Nothing is installed globally for you. Either load it for one run:

```
pi -e /path/to/thisisfine/integrations/pi/index.ts
```

or add it yourself (`pi install /path/to/thisisfine`, or list `integrations/pi/index.ts` under `extensions` in your pi settings). The package's `pi` field also offers the `writing-promises` skill and the `/promise`, `/promises`, `/retire` prompts. The extension stays silent in any folder without `.thisisfine/config.json`.

## What maps to what

| Guarantee | Claude Code | pi |
| --- | --- | --- |
| Context at session start | `SessionStart` hook | `before_agent_start` appends it to the system prompt; `session_start` shows pending questions |
| Lock on the human's "y" | `UserPromptSubmit` hook | `input` event. The lock records the session leaf (`prompt_id`) and session file |
| Guard on edits | `PreToolUse` hook | `tool_call` for `bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, returning `{block, reason}` |
| Gate before finishing | `Stop` hook | `agent_end` queues a `followUp` with `triggerTurn`, which makes pi keep going |

## What pi can't give you

- **No proof of who typed the words.** Claude Code's transcript marks each prompt `origin: human`. pi's session file has no such field, so `thisisfine verify` can only say the words are there under the right prompt, not that a person typed them. The extension narrows the gap instead: it ignores any message with `source: "extension"`, and it treats a pi started from inside another agent as unable to lock (below).
- **The nested-agent check is best-effort.** The extension sets `THISISFINE_UNDER_AGENT` and pi's bash tool exports `PI_SESSION_ID`. A `pi -p y` run from the agent's shell sees either and refuses to lock. A command that clears the environment (`env -i pi -p y`) gets past it. The guard denies commands that mention those names, but that is a speed bump like the rest of the guard; the signature, mirror and `verify` are the backstop.
- **RPC input counts as a person.** pi's `rpc` source can't be told from a human, so it is allowed.
- **The gate skips aborted or errored runs**, as Claude Code's does when you interrupt.
- **Each tool call starts a Node process** for the guard, a few tens of milliseconds.
- **A crashed hook allows.** If the CLI dies, the call or stop goes through, as in the plugin.

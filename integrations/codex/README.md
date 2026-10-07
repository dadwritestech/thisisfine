# thisisfine for Codex

The same promises, ledger and CLI as the Claude Code plugin, driven by [Codex](https://developers.openai.com/codex) hooks (the CLI and the ChatGPT desktop app). Codex's hooks speak the same JSON as Claude Code's, so there is no adapter: four lines of `.codex/hooks.json` call `thisisfine hook-*` directly. A project can use Claude Code, pi and Codex side by side.

## Install

```
npm install -g @dadwritestech/thisisfine
```

Then copy [hooks.json](hooks.json) to `.codex/hooks.json` in your project. Codex asks you to review new hooks before it runs them; accept these four.

Working from a clone instead? Replace each `thisisfine` command with `node /path/to/thisisfine/bin/thisisfine.mjs`.

Nothing touches your global `~/.codex/config.toml`. The hooks stay silent in any folder without `.thisisfine/config.json`, and the first `thisisfine propose` (or `thisisfine init`) sets that up.

Codex reads the `writing-promises` skill from the thisisfine folder by itself once the session context points at it. There are no `/promise` commands: say "lock that in" or "make that a promise", or just tell Codex something works.

## What maps to what

| Guarantee | Claude Code | Codex |
| --- | --- | --- |
| Context at session start | `SessionStart` hook | `SessionStart` hook; the context reaches the model as a developer message |
| Lock on the human's "y" | `UserPromptSubmit` hook | `UserPromptSubmit` hook. The lock records Codex's `turn_id` and session file |
| Guard on edits | `PreToolUse` on `Edit`, `Write`, `Bash`… | `PreToolUse` on `Bash` and `apply_patch`; every file a patch adds, updates, deletes or moves to is checked |
| Gate before finishing | `Stop` hook | `Stop` hook |
| `thisisfine verify` | transcript entry marked `origin: human` | the session file's `UserMessage` in the lock's turn |

## What Codex can't give you (yet)

- **The sandbox and the browser.** On Windows, Codex's sandbox sometimes refuses to start Chromium (`spawn EPERM`), on and off for the same command. `thisisfine propose` then says it couldn't start the browser rather than calling your check broken: rerun it with escalated permissions or from your own terminal. Hooks run outside the sandbox, so the Stop gate isn't affected.
- **`thisisfine check` inside the sandbox** can't write its state under `~/.thisisfine` in `workspace-write` mode. The Stop hook does the same job from outside the sandbox.
- **Who typed the words.** Codex's session file records user messages but not whether a person or a script sent them (`codex exec "y"` looks the same). The nested-agent check covers the obvious case: Codex exports `CODEX_THREAD_ID` to every shell command, so a `codex exec y` run by the agent refuses to lock. As with pi, the signature, mirror and `verify` are the backstop.
- **Each tool call starts a Node process** for the guard, a few tens of milliseconds.

## Tested

Against Codex CLI 0.160 (gpt-5.6-terra) on Windows: a live session proposed, locked on "y, perfect", refused to edit the locked check, caught a broken badge with `thisisfine check`, fixed the app rather than the check, and `thisisfine verify` matched the lock to Codex's session file. A PreToolUse `deny` on `apply_patch` blocks the patch and shows Codex the reason.

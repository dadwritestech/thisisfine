---
description: Lock in a behaviour that works right now, so Claude can't quietly break it later
argument-hint: "[the behaviour, e.g. adding an item updates the cart badge]"
---

The human wants to lock in this behaviour as a thisisfine promise: $ARGUMENTS

If that is empty, use the behaviour they most recently confirmed in this conversation. If you can't tell which one they mean, ask them in one short question and stop.

Steps (the thisisfine CLI command is in your session context; below it's written `thisisfine`):

1. If the project has no `.thisisfine/config.json`, run `thisisfine init` first and tell the human what start command it detected.
2. Follow the `writing-promises` skill: write ONE sentence and ONE Playwright check for it in `.thisisfine/checks/<next number>-<short-slug>.spec.ts`.
3. Run `thisisfine propose --sentence "<sentence>" --check .thisisfine/checks/<file>.spec.ts`. thisisfine runs the check itself: once against the app as it is now, once against a version without the change.
4. If propose says the check fails on the current app, fix the **check** (not the app) and propose again. If it says unproven because the check also passes on the older version, retry with `--sabotage` as the skill describes.
5. Relay the question propose prints, word for word, and end your turn. Do not say it's locked: only the human's reply can lock it.

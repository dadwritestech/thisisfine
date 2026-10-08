---
name: writing-promises
description: Use when turning a behaviour the human confirmed into a thisisfine promise (after "/promise", after they say it works, or when thisisfine nudges you), and when a thisisfine check blocks you from stopping.
---

# Writing promises

A promise is **one sentence** the human agrees with and **one check** that proves it from the outside: in a real browser, over HTTP, or by running the project's CLI. Once the human replies `y`, the check runs before every stop, and you can't edit it. Write it as if a stranger will read the failure message months from now, because that's exactly who will.

## The sentence

- Something a user can see or do, in present tense: "Adding an item updates the cart badge", "Logged-out visitors are sent to /login", "An expired token gets a 401", "`notes add --dry-run` writes nothing". For an API or a CLI, the user is whoever calls it, so a status code or an exit code is fair game.
- One behaviour. If you need "and", that's two promises.
- No implementation details ("the reducer", "the cache layer"). The human locks what they saw, not how it's built.

## The check

`<number>` is the next free promise number (`thisisfine status` shows the existing ones). Pick the runner by what the project is written in, and by what the human saw:

| What | File | Imports |
|---|---|---|
| A web page (any project) | `.thisisfine/checks/<number>-<slug>.spec.ts` | `@playwright/test`, or `../tif` for `run`/`write`/`read` |
| An API or CLI in a Python project | `.thisisfine/checks/<number>-<slug>.py` | `thisisfine_check` (and the standard library) |
| An API or CLI in a Go project | `.thisisfine/checks/<number>-<slug>/check_test.go`, alone in its folder | `thisisfine.local/checks/tif` (and the standard library) |

Every check is **black-box**: it reaches the app over HTTP (relative URLs, thisisfine starts the app on a free port), through the CLI configured as `"cli"` in `.thisisfine/config.json`, or in the browser. It never imports the project's code: `propose` refuses a check that does. The CLI runs in a fresh scratch folder per test, with its own `HOME`, so `write` the files it reads and `read`/`Exists` what it wrote.

```ts
import { test, expect } from "@playwright/test";

test("adding an item updates the cart badge", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  await expect(page.getByTestId("cart-count")).toHaveText("1");
});
```

```python
from thisisfine_check import api, run, write, read


def test_an_expired_token_gets_a_401():
    r = api.get("/me", headers={"Authorization": "Bearer old-token"})
    assert r.status_code == 401


def test_dry_run_writes_nothing():
    r = run("add", "buy milk", "--dry-run")
    assert r.code == 0, r.err
    assert read("notes.txt") is None
```

```go
package checks

import (
	"testing"

	"thisisfine.local/checks/tif"
)

func TestDryRunWritesNothing(t *testing.T) {
	r := tif.Run(t, "add", "buy milk", "--dry-run")
	if r.Code != 0 {
		t.Fatalf("exit %d: %s", r.Code, r.Err)
	}
	if tif.Exists(t, "notes.txt") {
		t.Fatalf("--dry-run wrote notes.txt: %q", tif.Read(t, "notes.txt"))
	}
}
```

In Go, `tif.API(t).Get("/me", "Authorization", "Bearer old-token")` returns a `Response` with `Status`, `Header`, `Body` and `.JSON(t, &v)`. In a `.spec.ts`, Playwright's own `request` fixture calls an API, and `import { test, expect } from "../tif"` adds `run`, `write` and `read` for a CLI.

If `.thisisfine/config.json` has no `"cli"` and you need one, or no `"start"` for an API, tell the human what to set (for example `"cli": "{app}/.thisisfine/bin/notes{exe}"` with `"build": "go build -o .thisisfine/bin/notes{exe} ./cmd/notes"`). Only they can change the config.

For browser checks:

- Use relative URLs (`page.goto("/")`). thisisfine starts the app on a free port and sets `baseURL`.
- Find elements the way a user does: `getByRole`, `getByLabel`, `getByText`, or a `data-testid` that already exists. Avoid CSS chains that break on harmless restyling.
- Assert the specific thing in the sentence (`toHaveText("1")`), not just that something exists.
- Every run starts the app fresh, but databases and files persist between runs. Create the data the check needs, and don't depend on what an earlier run left behind.
- The app runs in the human's own folder, so a check that clicks "Save" saves for real, every Stop. `propose` lists any project files the app wrote. If one holds real data (`config.json`, a `.db`), tell the human and suggest a `start` command that uses a scratch copy. Only they can change `.thisisfine/config.json`. Then propose again.
- If a first-run wizard, cookie banner or modal can appear, dismiss it with `page.addLocatorHandler(overlay, () => skipButton.click())`. Otherwise it appears on a timer and blocks your click on some runs and not others. That makes the check flaky, and the proof may not catch it.
- Let the page finish loading before you read state from it. If the check reads the current state to decide what to do (a toggle, "flip whatever is showing"), assert both directions. One direction can pass by accident when a saved default happens to equal the value you expect.

For every check:

- Keep it under ~10 seconds. No skips (`test.skip`, `pytest.mark.skip`, `t.Skip`), no `test.only`, and no fixed sleeps.
- Assert the specific thing in the sentence: the status code and the error, the exit code and the file that must not exist.

## Proving it

`thisisfine propose` runs the check twice, and you never report the result yourself:

1. **Now**: it must pass on the first try. A flaky check is refused.
2. **Without the behaviour**: it must fail while the app still starts. By default that version is the last commit (if the app has uncommitted changes) or the one before it. Use `--base <ref>` to pick another.

If the behaviour is older than that commit, the check passes both times and the promise is **unproven**. Prove it with a sabotage patch instead: a minimal diff that removes just this behaviour and leaves the app booting. Write it to `.thisisfine/runs/` (ignored by git):

```diff
--- a/public/app.js
+++ b/public/app.js
@@ -12 +12 @@
-  badge.textContent = String(cart.length);
+  badge.textContent = "0";
```

```bash
thisisfine propose --sentence "Adding an item updates the cart badge" \
  --check .thisisfine/checks/1-cart-badge.spec.ts \
  --sabotage .thisisfine/runs/no-badge.patch --sabotage-note "badge never updates"
```

The patch is only applied to a temporary copy of the project. Your working tree is never touched.

An unproven promise can still be locked; it's shown as 🟡. A proven one is better: it's a check that has actually been seen to catch the bug.

## Asking

Propose prints a question. Relay it word for word and end your turn. Never say a promise is locked until the human has replied: their `y` is what locks it, and thisisfine records their exact words.

## When a promise blocks you

The Stop hook ran the locked checks and one failed. The message quotes the human's own words from when they locked it.

1. Read the failure and the screenshot or evidence it names.
2. Fix the **app**. Don't edit the check, `promises.jsonl`, or `.thisisfine/config.json`; the guard will refuse, and the integrity check would catch it anyway.
3. If the human's latest request really does mean this behaviour should change, stop and say so. Ask them to retire the promise (`/retire <n> <reason>`, or `thisisfine retire <n> --reason "..."`), or propose a replacement with `--replaces <n>`.

After three failed attempts at the same promise, thisisfine lets you stop and hands the decision to the human. That's not a pass: tell them plainly what you couldn't fix.

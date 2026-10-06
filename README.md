<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/mascot-dark.png">
    <img src="docs/img/mascot.png" width="280" alt="The thisisfine mascot: a coffee mug with a padlock on its chest, smiling calmly and raising a tiny cup while the room burns around it">
  </picture>
</p>

<h1 align="center">thisisfine</h1>

<p align="center">
  <a href="https://github.com/dadwritestech/thisisfine/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/dadwritestech/thisisfine/test.yml?branch=main&amp;label=tests&amp;logo=githubactions&amp;logoColor=white&amp;style=flat-square&amp;labelColor=2b1d12" alt="Tests"></a>
  <a href="#install"><img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20pi-ff7a1a?style=flat-square&amp;labelColor=2b1d12&amp;logo=claude&amp;logoColor=white" alt="Works with Claude Code, Codex and pi"></a>
  <img src="https://img.shields.io/badge/checks-Playwright%2C%20real%20browser-ff7a1a?style=flat-square&amp;labelColor=2b1d12" alt="Checks run in a real browser with Playwright">
  <img src="https://img.shields.io/badge/runtime%20deps-0-ff7a1a?style=flat-square&amp;labelColor=2b1d12" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-ff7a1a?style=flat-square&amp;labelColor=2b1d12&amp;logo=nodedotjs&amp;logoColor=white" alt="Node 22.18 or newer">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff7a1a?style=flat-square&amp;labelColor=2b1d12" alt="MIT license"></a>
  <a href="https://github.com/dadwritestech/thisisfine/stargazers"><img src="https://img.shields.io/github/stars/dadwritestech/thisisfine?label=stars&amp;color=ff7a1a&amp;style=flat-square&amp;labelColor=2b1d12" alt="GitHub stars"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/your%20agent-%E2%9C%85%20done%21-2ea043?style=flat-square&amp;labelColor=2b1d12" alt="Your agent: done!">
  <img src="https://img.shields.io/badge/your%20app-%F0%9F%94%A5%20on%20fire-d1242f?style=flat-square&amp;labelColor=2b1d12" alt="Your app: on fire">
  <img src="https://img.shields.io/badge/status-this%20is%20fine-ff4d00?style=flat-square&amp;labelColor=2b1d12" alt="Status: this is fine">
  <img src="https://img.shields.io/badge/coffee-still%20hot-8b5a2b?style=flat-square&amp;labelColor=2b1d12" alt="Coffee: still hot">
  <img src="https://img.shields.io/badge/vibes-%F0%9F%94%92%20locked-6e40c9?style=flat-square&amp;labelColor=2b1d12" alt="Vibes: locked">
  <img src="https://img.shields.io/badge/excuses%20accepted-0-57606a?style=flat-square&amp;labelColor=2b1d12" alt="Excuses accepted: 0">
</p>

<p align="center">
  <b>Your coding agent says "✅ Done" while your app is on fire.</b><br>
  thisisfine turns every behaviour you said <i>yes</i> to into a locked, proven browser check,<br>
  and won't let Claude finish a turn that breaks one.
</p>

<p align="center">
  <img src="docs/img/demo.gif" alt="Demo, recorded from a real end-to-end run. You ask Claude for a cart badge; thisisfine proves the check passes now and fails without the change, and the shop shows the badge at 2. You reply 'y, perfect' and promise #1 is locked. Weeks later a 'small cleanup' makes the badge count distinct products, Claude tries to stop and is blocked with '🔥 This is NOT fine', Expected 2, Received 1, and the shop shows the badge at 1. Claude's attempt to edit the check is denied, it fixes the app instead, and the turn ends with '☕ This is fine. 1/1 promises kept.'" width="100%">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#the-30-second-story">The 30-second story</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-it-cant-do">What it can't do</a> ·
  <a href="#faq">FAQ</a>
</p>

---

It worked yesterday. You checked it yourself and told Claude "perfect". Today Claude tidied up some code, and the thing you checked is quietly broken. Nobody noticed, because the only record that it ever worked was one word in a chat that's long gone.

thisisfine keeps that word. When you say yes to a behaviour, it becomes a **promise**: one sentence you agreed with, plus one Playwright check that proves it in a real browser. Before Claude can end a turn, every promise is checked. If one is broken, Claude is sent back to fix the app, with your own words quoted back to it.

## The 30-second story

This is a real run of the [example shop](examples/cart), the same steps the [end-to-end test](test/e2e.test.ts) replays in a real browser.

**1. You ask for a cart badge. Claude builds it, writes a check, and thisisfine proves the check can actually fail:**

```
✔ passes now ✔ fails on HEAD (app still boots)

Lock in promise #1 "Adding a coffee twice shows 2 on the cart badge"? ✔ passes now ✔ fails on HEAD (app still boots)
Reply y to confirm, anything else to skip.
```

**2. You reply `y, perfect`.**

```
🔒 Locked promise #1 "Adding a coffee twice shows 2 on the cart badge".
```

**3. Every turn after that ends with:**

```
☕ This is fine. 1/1 promises kept.
```

**4. Weeks later you ask for "a small cleanup of the cart code". Claude counts distinct products instead of items, which looks reasonable and is wrong. Claude tries to stop, and can't:**

```
🔥 This is NOT fine. You broke promise #1 "Adding a coffee twice shows 2 on the cart badge".
   The human confirmed it on Oct 4: "y, perfect"
   Check: .thisisfine/checks/1-cart-badge.spec.ts
   Failure:
     Error: expect(locator).toHaveText(expected) failed
     Locator:  getByTestId('cart-count')
     Expected: "2"
     Received: "1"
   Screenshot: .thisisfine/runs/…/test-failed-1.png

Fix the app so #1 holds again. Do not edit the checks, the ledger, or the config.
```

<table>
  <tr>
    <th>When you said yes</th>
    <th>After the "cleanup"</th>
  </tr>
  <tr>
    <td><img src="docs/img/badge-works.png" alt="Fine Coffee Co. shop: two House blends added, cart badge shows 2"></td>
    <td><img src="docs/img/badge-broken.png" alt="The same shop after the refactor: two House blends added, cart badge shows 1"></td>
  </tr>
</table>

**5. Claude fixes the app, not the check, and you get your coffee back:** `☕ This is fine. 1/1 promises kept.`

If Claude tries to edit the check instead, it's refused before the edit happens:

```
thisisfine: this check is promise #1 "Adding a coffee twice shows 2 on the cart badge", which the human locked.
Fix the app, not the check.
```

## Install

You need [Claude Code](https://claude.com/claude-code), Node 22.18 or newer, git, and a web app that starts with one command.

In Claude Code:

```
/plugin marketplace add dadwritestech/thisisfine
/plugin install thisisfine@thisisfine
```

Then, in your project:

```
/promise the cart badge shows how many items are in the cart
```

The first `/promise` sets up `.thisisfine/` in your repo and installs Playwright *into that folder* (your own `package.json` is untouched). Commit `.thisisfine/` so your promises travel with the code.

You don't have to type `/promise`. When you tell Claude something works ("works!", "perfect", "lgtm"), thisisfine reminds it to offer a promise. That happens at most once every five prompts, so it won't nag.

**Using pi or Codex instead?** See [integrations/pi](integrations/pi/README.md) and [integrations/codex](integrations/codex/README.md) for the setup and what each can and can't guarantee.

## How it works

```
 you: "perfect"  ──▶  Claude writes a check  ──▶  thisisfine proves it  ──▶  you: "y"  ──▶  🔒 locked
                                                  passes now,                              runs before
                                                  fails without the change                 every stop
```

1. **A promise is one sentence and one check.** The sentence is about something a user can see ("Logged-out visitors are sent to /login"), not how it's built. The check is a black-box [Playwright](https://playwright.dev) test in `.thisisfine/checks/`.
2. **thisisfine proves the check, not Claude.** It starts your app and runs the check on the code as it is now: it must pass on the first try. Then it runs the check on a version *without* the change, either the previous commit or a temporary copy with a small "sabotage" patch applied. The check must fail there while the app still boots. A check that can't fail is labelled 🟡 *unproven*, so you know it's weaker.
3. **Only you can lock it.** Your reply goes through a Claude Code hook, not through Claude. A whole-message "yes" (`y`, `yes`, `ok`, `lock it`, `y, perfect`, `👍`, `haan`, …) locks the promise. Anything else, like "yes but make it blue", skips it. thisisfine records your exact words and signs the record with a private key that lives outside the repo. Its public half goes into `.thisisfine/keys/`, so anyone with the repo can check the signature.
4. **Every stop is a gate.** When Claude tries to end a turn, thisisfine starts the app once and runs every promise. If they all pass, Claude stops with `☕ This is fine.` If one fails, Claude is sent back with the sentence, your words, the assertion, and a screenshot. Nothing changed since the last green run? It doesn't run anything.
5. **Changing your mind is allowed, out loud.** If you really do want the behaviour to change, `/retire 3 we're dropping the badge` asks you to confirm, and only your `y` retires it. Claude is told to ask for this, not to route around a promise.

Three slash commands: `/promise <sentence>`, `/promises` (list them), `/retire <n> <why>`.

## For vibecoders

You don't need to know what a test is. You say "perfect" when something works, and Claude asks if you want to lock it in. From then on, if Claude breaks it, Claude finds out before you do, and has to fix it before it's allowed to say it's done. The messages are in plain English and quote what you said.

## For developers

- **Zero runtime dependencies.** The plugin is plain TypeScript, run straight from the git checkout by Node's built-in type stripping, so it has no build step. The npm package ships the same code compiled to JavaScript in `dist/`, because Node won't strip types inside `node_modules`. Playwright is pinned and installed into `.thisisfine/` only.
- **Black-box checks.** Checks can't import your code. They drive a real browser against your app on a free port (`PORT` is set, and `{port}` in the start command is replaced). Next.js and Vite are detected; anything else uses your `dev` or `start` script. Edit `.thisisfine/config.json` to change it.
- **Fast when nothing changed.** The gate hashes the working tree (tracked and untracked files, respecting `.gitignore`) and skips the run when it matches the last green tree. On the example shop, a passing gate takes about 1.3 s and proving a new promise about 13 s.
- **Only what a change can affect.** After a full green run, thisisfine knows which files each promise's check loaded (it records them through a local proxy, no code changes). A later change to, say, `about.html` re-checks only the promises that visit it. Anything it can't map (backend code, config, a new file) re-checks everything, and every fifth run is a full one anyway. On the example shop every promise loads the same three files, so there is nothing to skip; the gain shows up when promises cover different pages.
- **A crash is named, not guessed.** When a check fails, thisisfine opens the page once more and reports any script error with its file and line (`SyntaxError: … (/app.js:6:91)`), so a typo that kills the whole page doesn't read as just `Received: "0"`. Errors thrown while the check itself runs (a click handler that throws) come from that check's own Playwright trace, also with file and line; failing runs keep the trace in `.thisisfine/runs/` for `npx playwright show-trace`.
- **Flaky isn't failing.** The gate retries once. A check that passes on retry is reported as flaky and doesn't block. Proving a promise allows no retries, so a flaky check is refused at the door.
- **The same CLI Claude uses** is yours too: `status`, `check`, `verify`, `restore`, and more. Run `node <path-to-plugin>/bin/thisisfine.mjs --help`, or just ask Claude to run it.

## For team leads

- **Promises live in git.** `.thisisfine/promises.jsonl` is an append-only ledger: who agreed to what, when, in their own words, and whether the check was proven. It shows up in PR diffs like any other file.
- **Agent-written tests encode whatever the code does, bugs included.** Promises encode what a human looked at and agreed to. That's the one piece of ground truth in AI-assisted coding, and today it gets thrown away with the chat.
- **`thisisfine verify`** audits every lock: the signature and which key made it, the check file's hash, and whether Claude Code's own transcript shows a person (not a tool) typing those exact words.
- **Verifiable by teammates and CI.** Locks are signed with Ed25519. The private key stays in `~/.thisisfine/`; the public key is written to `.thisisfine/keys/<you>.pub` the first time you lock something. Commit it, and `thisisfine verify --strict` checks every lock on any machine, without any private key. `--strict` also fails on a lock that no committed key can check, which is what CI wants.
- **Review `.thisisfine/keys/` like code.** A key in that folder vouches for every lock it signs, so whoever can add a key there can add promises. The agent can't write there, but a person can. Put the folder under `CODEOWNERS` and treat a new key in a PR the way you'd treat a new deploy credential.

## In CI

The Stop hook guards your own machine. The GitHub Action guards the branch: it runs every promise in a real browser on each pull request, fails the job if one is broken, and posts a **behaviour diff**, which shows what the PR does to the promises rather than to the code.

```yaml
# .github/workflows/promises.yml
name: promises
on: pull_request
permissions:
  contents: read
  pull-requests: write   # for the comment; drop it and set comment: false to only use the job summary
jobs:
  thisisfine:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci                            # your app's dependencies: the checks start your app
      - uses: dadwritestech/thisisfine@main    # pin a commit SHA for anything serious
        # with:
        #   working-directory: web             # if .thisisfine/ isn't at the repo root
```

The action installs Playwright into `.thisisfine/` (as `init` does), runs `thisisfine check`, and then compares the ledger on the PR with the one on its base:

```diff
### thisisfine: what this branch does to the promises (vs 4f1c2e9)

✗ #1 broken: "Adding a coffee twice shows 2 on the cart badge"
    Expected: "2"
    Received: "1"
+ #4 locked: "Logged-out visitors are sent to /login" ✅ proven ("y, perfect", Oct 6)
- #2 retired: "The footer shows the shop's opening hours" (hours moved to the contact page)
? #5 waiting for a human y: "Search finds a coffee by name"
✔ 2 promises kept (#3, #4)
```

The job fails when a promise is broken, when a locked check was edited, or when the PR deleted or rewrote lines from the base's ledger (it's append-only, and CI has no home-directory copy to restore from, so this is how CI notices). Screenshots of failures are uploaded as the `thisisfine-runs` artifact.

**Signatures in CI:** each lock is signed with a private key that never leaves the machine where the human said yes, and the matching public key is written to `.thisisfine/keys/` for you to commit. CI checks every new confirmation against those committed keys: a forged or edited one fails the diff. A confirmation signed with a key that isn't committed yet gets a note under the summary instead of a failure. Run `thisisfine verify --strict` if you'd rather fail on those too.

The same two commands work locally, before you push:

```bash
node <path-to-plugin>/bin/thisisfine.mjs check --report report.json
```

```bash
node <path-to-plugin>/bin/thisisfine.mjs diff origin/main --report report.json
```

## What it can't do

thisisfine can't stop an agent that is determined to cheat. It makes cheating loud.

- **Tamper-evident, not tamper-proof.** Each lock is signed with a private key in `~/.thisisfine/`, and mirrored there too. If a locked check, the ledger, or the config is changed or deleted, the next stop is blocked until `thisisfine restore` puts back exactly what you confirmed. The guard that refuses edits up front is a speed bump. Shell commands can be written in endless ways, and it only catches the common ones.
- **A committed key is only as trusted as the commit that added it.** Anyone can check a signature against `.thisisfine/keys/`, but the folder itself is just files in git. An agent that slips a key past the guard and past review can sign locks of its own. They can only *add* promises, though: on your machine, only your own key can retire or replace a promise you locked, whatever keys are committed. In CI, `verify` names the key behind every lock, so a stranger's key stands out.
- **Older locks stay per machine.** Locks made before Ed25519 signing are HMAC-signed with `~/.thisisfine/key`. They still verify on the machine that made them, and anywhere else `verify` says no committed key can check them (a failure under `--strict`). To make one checkable everywhere, retire it and lock it again.
- **The transcript check is local.** Claude Code's transcript stays on the machine where you typed "y", so a teammate's `verify` checks the signature and the check file, not the transcript.
- **Claude Code, Codex, pi, and web apps only, for now.** pi works through [an extension](integrations/pi/README.md) and Codex through [four hooks](integrations/codex/README.md), each with one weaker guarantee: their session files can't prove a person typed the "y". Codex's Windows sandbox also sometimes won't start the browser for `propose`. Other agents (Cursor) and non-browser checks are out of scope for v0.
- **It's only as good as the check.** A promise proves the check can fail when the behaviour is gone. It doesn't prove the check covers everything you had in mind. That's why the sentence is short, and why a person has to say yes.
- **Your app runs in your folder.** If a check clicks Save, it really saves, before every stop. `propose` names any project file the app wrote while the check ran, so you can point `start` at a scratch copy before you say yes. (We learned this the hard way: on a real app, a theme check rewrote `config.json`, and that saved setting later made the check pass with the feature broken.)
- **Not on npm yet.** The package builds and installs (`npm pack`, then `npx thisisfine --help` works), but it hasn't been published. For now, install it as a Claude Code plugin.

## FAQ

**Why not just ask Claude to write tests?**
Because Claude writes tests for the code it wrote, and can edit them when they get in the way. A promise starts from you saying yes, is proven to fail without the behaviour, and is locked against edits.

**How is this different from TestSprite or Shiplight?**
They generate and maintain tests for you. TestSprite saves the behaviours its agent has verified. Shiplight's tests repair themselves as the app changes. thisisfine only locks what a *person* confirmed, and deliberately never repairs a failing check: a failure means "go fix the app", not "update the test".

**And nocap, trust-issues, agent-guard, or Kvitansiya?**
Those watch *how* the agent works: skipped tests, weakened asserts, claims of "tests pass" without running them, or checking the agent's claimed result at the end of a session. They protect tests that already exist. thisisfine creates the checks from your confirmations and enforces them at every stop. They complement each other well.

**Will it slow Claude down?**
A turn that changed nothing costs nothing. A turn that changed code costs one app boot plus your checks, about a second for the example shop. A failing check takes longer (it waits for the assertion, then retries once), but that's the turn you wanted stopped.

**What if a check is flaky or the app won't start?**
Flaky checks warn and don't block. If the app can't start, Claude is blocked with the start error, because "couldn't check" isn't "fine". If the same block happens three times in a row, thisisfine lets Claude stop and hands the decision to you, so you're never stuck in a loop.

**Why the name?**
It's the face every coding agent makes while it reports success from inside a burning building. The phrase comes from KC Green's comic *On Fire*. thisisfine isn't affiliated with it, and the art here is original.

## Contributing

```bash
npm install
npm test
```

```bash
npm run typecheck
```

You don't need to build anything to work on it: `bin/thisisfine.mjs` runs `src/` directly whenever `src/` exists. `npm run build` compiles `src/` to `dist/` for the npm package, and `npm pack` runs it for you (`prepack`). The package ships `dist/` and leaves out `src/`, which is how the bin knows to use the compiled code.

The end-to-end test installs Playwright and drives a real browser through the whole story above. It's opt-in:

```bash
THISISFINE_E2E=1 npm run test:e2e
```

The demo GIF at the top is filmed from that run: every line of thisisfine output in it, and both shop screenshots, come from the test. To re-film it:

```bash
npm run demo
```

## License

[MIT](LICENSE)

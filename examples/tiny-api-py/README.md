# Fine Notes API

A tiny HTTP service with no dependencies, used by the thisisfine walkthrough and end-to-end test.

It ships with a bug on purpose: `GET /me` lets an expired session token in. Ask Claude to fix it, say `y` when thisisfine asks you to lock "an expired token gets a 401", then ask for "a cleanup of the auth code" and see what happens.

```bash
python app.py --port 8000
```

`.thisisfine/config.json` after `thisisfine init`:

```json
{ "start": "\"{python}\" app.py --port {port}" }
```

`{python}` is thisisfine's own venv, so the app runs on a known Python 3 on every OS.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverage, FULL_EVERY_MS, FULL_EVERY_RUNS, selectChecks, usesOwnHttp } from "../src/select.ts";
import type { Hit } from "../src/select.ts";
import type { Coverage } from "../src/types.ts";

const A = ".thisisfine/checks/1-a.spec.ts";
const B = ".thisisfine/checks/2-b.spec.ts";
const C = ".thisisfine/checks/3-c.spec.ts";

const get = (url: string, blob: string | null, status = 200): Hit => ({ method: "GET", url, status, blob });

const blobs = new Map<string, string[]>([
  ["b-index", ["public/index.html"]],
  ["b-app", ["public/app.js"]],
  ["b-about", ["public/about.html"]],
  ["b-empty", ["public/empty.txt", ".thisisfine/checks/.gitkeep"]]
]);

test("a response whose body is exactly one repo file maps that file to the check", () => {
  const cov = buildCoverage({
    tree: "T1", madeAt: "2026-10-06T10:00:00.000Z", blobs,
    hits: new Map([[A, [get("http://localhost:5000/", "b-index"), get("http://localhost:5000/app.js", "b-app")]], [B, [get("http://localhost:5000/about.html", "b-about")]]]),
    ownHttp: []
  });
  assert.deepEqual(cov.files, { "public/about.html": [B], "public/app.js": [A], "public/index.html": [A] });
  assert.deepEqual(cov.dynamic, []);
  assert.deepEqual(cov.checks, [A, B]);
  assert.equal(cov.tree, "T1");
  assert.equal(cov.selectedRuns, 0);
});

test("a body no repo file explains makes the check dynamic", () => {
  const cov = buildCoverage({
    tree: "T1", madeAt: "x", blobs, ownHttp: [],
    hits: new Map([[A, [get("http://localhost:5000/", "b-index"), get("http://localhost:5000/api/cart", "b-json")]], [B, [get("http://localhost:5000/", "b-index")]]])
  });
  assert.deepEqual(cov.dynamic, [A]);
});

test("errors, websockets and undecodable bodies are dynamic; a missing favicon is not", () => {
  const dyn = (hit: Hit) => buildCoverage({ tree: "T", madeAt: "x", blobs, ownHttp: [], hits: new Map([[A, [hit]]]) }).dynamic;
  assert.deepEqual(dyn(get("http://localhost:5000/missing", null, 404)), [A]);
  assert.deepEqual(dyn(get("http://localhost:5000/app.js", "b-app", 500)), [A]);
  assert.deepEqual(dyn(get("http://localhost:5000/app.js", "b-app", 304)), [A]);
  assert.deepEqual(dyn({ method: "GET", url: "http://localhost:5000/_hmr", status: 101, blob: null }), [A]);
  assert.deepEqual(dyn(get("http://localhost:5000/app.js", null)), [A]);
  assert.deepEqual(dyn({ method: "POST", url: "http://localhost:5000/app.js", status: 200, blob: "b-app" }), [A]);
  assert.deepEqual(dyn(get("http://localhost:5000/favicon.ico", null, 404)), []);
});

test("other hosts are outside the repo and ignored; a tunnel to this machine is not", () => {
  const dyn = (hit: Hit) => buildCoverage({ tree: "T", madeAt: "x", blobs, ownHttp: [], hits: new Map([[A, [hit]]]) }).dynamic;
  assert.deepEqual(dyn(get("http://fonts.example.com/x.css", "zzz")), []);
  assert.deepEqual(dyn({ method: "CONNECT", url: "cdn.example.com:443", status: 0, blob: null }), []);
  assert.deepEqual(dyn({ method: "CONNECT", url: "localhost:5443", status: 0, blob: null }), [A]);
  assert.deepEqual(dyn(get("http://127.0.0.1:5001/api", "zzz")), [A]);
  assert.deepEqual(dyn(get("http://[::1]:5001/api", "zzz")), [A]);
  assert.deepEqual(dyn(get("http://app.localhost:5001/api", "zzz")), [A]);
});

test("a body matching several files maps none of them, so changing any of them runs everything", () => {
  const cov = buildCoverage({ tree: "T", madeAt: "x", blobs, ownHttp: [], hits: new Map([[A, [get("http://localhost:5000/empty.txt", "b-empty")]]]) });
  assert.deepEqual(cov.files, {});
  assert.deepEqual(cov.dynamic, []);
});

test("a check that makes its own HTTP calls is dynamic: they never pass the browser's proxy", () => {
  const cov = buildCoverage({ tree: "T", madeAt: "x", blobs, ownHttp: [B], hits: new Map([[A, []], [B, []]]) });
  assert.deepEqual(cov.dynamic, [B]);
  assert.equal(usesOwnHttp(`test("x", async ({ request }) => { await request.get("/api"); });`), true);
  assert.equal(usesOwnHttp(`const r = await fetch("http://localhost/api");`), true);
  assert.equal(usesOwnHttp(`import http from "node:http";`), true);
  assert.equal(usesOwnHttp(`test("x", async ({ page }) => { await page.goto("/"); await expect(page.getByText("ok")).toBeVisible(); });`), false);
});

// ── selection ────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const coverage = (over: Partial<Coverage> = {}): Coverage => ({
  tree: "T1", madeAt: "2026-10-06T11:00:00.000Z", checks: [A, B, C],
  files: { "public/index.html": [A, B, C], "public/app.js": [A, B], "public/about.html": [C] },
  dynamic: [], selectedRuns: 0, ...over
});
const select = (changed: string[] | null, over: Partial<Parameters<typeof selectChecks>[0]> = {}) =>
  selectChecks({ active: [A, B, C], coverage: coverage(), tree: "T2", changedSince: () => changed, now: NOW, ...over });

test("a change only some promises loaded runs only those", () => {
  const s = select(["public/about.html"]);
  assert.deepEqual(s, { all: false, checks: [C], why: "only public/about.html changed" });
});

test("dynamic checks run whenever anything is selected", () => {
  const s = select(["public/about.html"], { coverage: coverage({ dynamic: [A] }) });
  assert.deepEqual(s.all ? [] : s.checks, [A, C]);
});

test("a change every promise loaded runs everything", () => {
  const s = select(["public/index.html"]);
  assert.equal(s.all, true);
});

test("any doubt runs everything", () => {
  const why = (s: ReturnType<typeof selectChecks>) => (s.all ? s.why : `selected ${s.checks.join(",")}`);
  assert.match(why(select(["public/about.html"], { tree: null })), /not a git repository/);
  assert.match(why(select(["public/about.html"], { coverage: null })), /no map/);
  assert.match(why(select(["server.mjs"])), /server\.mjs isn't served as-is to any check/);
  assert.match(why(select(["public/new.js"])), /new\.js isn't served/);
  assert.match(why(select(["public/about.html", ".thisisfine/checks/3-c.spec.ts"])), /promises or their checks changed/);
  assert.match(why(select([".thisisfine/promises.jsonl"])), /promises or their checks changed/);
  assert.match(why(select(null)), /can't tell what changed/);
  assert.match(why(select([])), /can't tell what changed/);
  assert.match(why(select(["public/about.html"], { active: [A, B, C, ".thisisfine/checks/4-d.spec.ts"] })), /promises or their checks changed/);
  assert.match(why(select(["public/about.html"], { coverage: coverage({ selectedRuns: FULL_EVERY_RUNS }) })), new RegExp(`${FULL_EVERY_RUNS} partial runs`));
  assert.match(why(select(["public/about.html"], { now: Date.parse(coverage().madeAt) + FULL_EVERY_MS + 1 })), /a day/);
  assert.match(why(select(["public/about.html"], { coverage: coverage({ madeAt: "garbage" }) })), /a day/);
});

test("a retired promise's check is not selected, and nothing selected means run everything", () => {
  assert.deepEqual(select(["public/app.js"], { active: [B, C] }), { all: false, checks: [B], why: "only public/app.js changed" });
  assert.equal(select(["public/about.html"], { active: [A, B] }).all, true);
});

test("the diff is always taken from the map's tree, never from a partial run's", () => {
  let from = "";
  select(["public/about.html"], { changedSince: (t) => { from = t; return ["public/about.html"]; } });
  assert.equal(from, "T1");
});

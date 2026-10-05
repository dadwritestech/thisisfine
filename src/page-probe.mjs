// Opens the app once and prints every uncaught error as one JSON line.
// Runs as its own process with the project's pinned Playwright (argv[2]),
// because thisisfine itself has no dependencies. Chromium's DevTools
// protocol is used instead of page.on("pageerror"): a SyntaxError reaches
// "pageerror" with an empty stack, so it would lose its file and line.
// Usage: node page-probe.mjs <@playwright/test index.mjs URL> <app URL>
const [playwrightUrl, appUrl] = process.argv.slice(2);
const { chromium } = await import(playwrightUrl);
const origin = new URL(appUrl).origin;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
    const what = (d.exception?.description ?? d.text ?? "error").split("\n")[0];
    const where = d.url ? ` (${d.url.replace(origin, "")}:${d.lineNumber + 1}:${d.columnNumber + 1})` : "";
    process.stdout.write(JSON.stringify(what + where) + "\n");
  });
  await cdp.send("Runtime.enable");
  await page.goto(appUrl, { timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
} finally {
  await browser.close();
}

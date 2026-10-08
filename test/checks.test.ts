import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKind, checkPathProblem, projectImports } from "../src/checks.ts";
import { put, tempDir } from "./helpers.ts";

test("the runner is chosen by the check's path", () => {
  assert.equal(checkKind(".thisisfine/checks/1-badge.spec.ts"), "playwright");
  assert.equal(checkKind(".thisisfine/checks/2-login.py"), "pytest");
  assert.equal(checkKind(".thisisfine/checks/3-dry-run/check_test.go"), "go");
  assert.equal(checkKind(".thisisfine/checks/notes.md"), null);
  assert.equal(checkKind(".thisisfine/checks/a/b/check_test.go"), null, "one directory deep only");
  assert.equal(checkKind(".thisisfine/checks/x/other_test.go"), null);
});

test("check paths that can't be a promise say why", () => {
  assert.equal(checkPathProblem(".thisisfine/checks/1-badge.spec.ts"), null);
  assert.equal(checkPathProblem(".thisisfine/checks/2-login.py"), null);
  assert.equal(checkPathProblem(".thisisfine/checks/3-x/check_test.go"), null);
  assert.match(checkPathProblem(".thisisfine/checks/thisisfine_check.py")!, /helper/);
  assert.match(checkPathProblem(".thisisfine/checks/conftest.py")!, /conftest/);
  assert.match(checkPathProblem(".thisisfine/checks/x.txt")!, /\.spec\.ts.*\.py.*check_test\.go/s);
  assert.match(checkPathProblem("src/x.spec.ts")!, /inside \.thisisfine\/checks/);
});

function project(files: Record<string, string>): string {
  const root = tempDir("tif-checks-");
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  return root;
}

test("python: importing the app's own packages breaks the black-box rule", () => {
  const root = project({
    "myapp/__init__.py": "", "src/billing/__init__.py": "", "tool.py": "",
    "pyproject.toml": `[project]\nname = "my-service"\n`
  });
  const check = ".thisisfine/checks/1-x.py";
  const bad = (src: string) => projectImports(root, check, src);
  assert.deepEqual(bad("import myapp\n"), ["import myapp"]);
  assert.deepEqual(bad("from myapp.models import User\n"), ["from myapp.models import User"]);
  assert.deepEqual(bad("from src.billing import x\n"), ["from src.billing import x"]);
  assert.deepEqual(bad("import billing\n"), ["import billing"]);
  assert.deepEqual(bad("import os, tool\n"), ["import os, tool"]);
  assert.deepEqual(bad("import my_service\n"), ["import my_service"], "the pyproject name, as an import");
  assert.deepEqual(bad("import sys\nsys.path.insert(0, '..')\n"), ["sys.path.insert(0, '..')"]);
  assert.deepEqual(bad("x = __import__('myapp')\n"), ["x = __import__('myapp')"]);
  assert.deepEqual(bad("import importlib\nimportlib.import_module('myapp')\n"), ["importlib.import_module('myapp')"]);
  assert.deepEqual(bad("import os, json, re\nimport requests\nfrom thisisfine_check import api, run\nimport pytest\n"), []);
  assert.deepEqual(bad("# import myapp\ntext = 'import myapp'\n"), [], "comments and strings aren't imports");
});

test("go: importing the app's module breaks the black-box rule", () => {
  const root = project({ "go.mod": "module example.com/shop\n\ngo 1.22\n" });
  const check = ".thisisfine/checks/1-x/check_test.go";
  const src = `package check

import (
\t"net/http"
\t"testing"

\t"thisisfine.local/checks/tif"
\tm "example.com/shop/internal/money"
)

import "example.com/shop"
`;
  assert.deepEqual(projectImports(root, check, src), [`m "example.com/shop/internal/money"`, `"example.com/shop"`]);
  assert.deepEqual(projectImports(root, check, `package check\nimport "example.com/shopping"\n`), [], "a prefix isn't the module");
});

test("js/ts: relative imports may not leave .thisisfine/", () => {
  const root = project({});
  const check = ".thisisfine/checks/1-x.spec.ts";
  const src = `import { test, expect } from "../tif";
import { price } from "../../src/price";
const db = require("../../../db.js");
const lazy = await import("../../lib/x.ts");
import type { Foo } from "@playwright/test";
`;
  assert.deepEqual(projectImports(root, check, src), [
    `import { price } from "../../src/price";`,
    `const db = require("../../../db.js");`,
    `const lazy = await import("../../lib/x.ts");`
  ]);
  assert.deepEqual(projectImports(root, check, `import x from "/abs/app/src/x";\n`), [`import x from "/abs/app/src/x";`]);
});

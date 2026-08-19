const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.join(__dirname, "..", "workflows", "pr-readiness-check.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const lines = workflow.split("\n");
const marker = "          script: |";
const markerIndex = lines.indexOf(marker);
assert.notEqual(markerIndex, -1, "github-script block must exist");
const scriptLines = [];
for (const line of lines.slice(markerIndex + 1)) {
  if (line.trim() && !line.startsWith("            ")) break;
  scriptLines.push(line.slice(12));
}
const script = scriptLines.join("\n");

const required = [
  "Spec alignment validated (`INDEX.md` + `dependencies.yaml`)",
  "Agent scoping verified on all new/changed data queries",
  "Input/config validation and bounds checks added",
  "Error handling and fallback paths tested (no silent swallow)",
  "Security checks applied to admin/mutation endpoints",
  "Docs updated for API/spec/status changes",
  "Regression tests added for each bug fix",
  "Lint/typecheck/tests pass locally",
];
const fullBody = required.map((item) => `- [x] ${item}`).join("\n");

async function run(livePr, eventPr) {
  const notices = [];
  const failures = [];
  const calls = [];
  const github = {
    rest: {
      pulls: {
        get: async (args) => {
          calls.push(args);
          return { data: livePr };
        },
      },
    },
  };
  const context = {
    repo: { owner: "Signet-AI", repo: "signetai" },
    issue: { number: 42 },
    payload: { pull_request: eventPr },
  };
  const core = {
    notice: (message) => notices.push(message),
    setFailed: (message) => failures.push(message),
  };
  const execute = new Function(
    "github",
    "context",
    "core",
    `return (async () => {\n${script}\n})();`,
  );
  await execute(github, context, core);
  return { notices, failures, calls };
}

test("reads the current PR body and enforces every mandatory item", async () => {
  for (const missing of required) {
    const liveBody = fullBody.replace(`- [x] ${missing}`, "");
    const result = await run(
      { body: liveBody, draft: false, labels: [] },
      { body: fullBody, draft: false, labels: [] },
    );
    assert.equal(result.failures.length, 1, `missing item was not rejected: ${missing}`);
    assert.ok(result.failures[0].includes(missing), `failure did not name missing item: ${missing}`);
  }
});

test("accepts the live complete body when the event payload is stale", async () => {
  const result = await run(
    { body: fullBody, draft: false, labels: [] },
    { body: "stale incomplete event body", draft: false, labels: [] },
  );
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.calls, [
    { owner: "Signet-AI", repo: "signetai", pull_number: 42 },
  ]);
});

test("uses live draft and exception-label state", async () => {
  const draft = await run(
    { body: "", draft: true, labels: [] },
    { body: fullBody, draft: false, labels: [] },
  );
  assert.equal(draft.failures.length, 0);
  assert.equal(draft.notices.length, 1);

  const exception = await run(
    { body: "", draft: false, labels: [{ name: "checklist-exception" }] },
    { body: "", draft: false, labels: [] },
  );
  assert.equal(exception.failures.length, 0);
  assert.equal(exception.notices.length, 1);
});

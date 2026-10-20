import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SafeEdgeBackend } from "./safe_edge_bridge_mcp.mjs";
import { parseJupyterJsonSnapshot } from "./jupyter_experiment_helpers.mjs";

// Deliberately use the real persistent intent/job methods, but never initialize
// a browser. Unique test-owned records are removed individually in finally.
const stateRoot = path.join(os.tmpdir(), "safe-edge-experiment-jobs");
const sourceZip = path.resolve(process.argv[2] || "fixtures/source.zip");
const args = {
  jupyterUrl: "http://aic.bnu.edu.cn/jupyter-forward/local-test/lab",
  sourceZip,
  bundleGlob: "H204_*_bundle.zip",
  waitSeconds: 900,
  downloadDirectory: path.resolve("test-downloads"),
};
const template = await new SafeEdgeBackend().buildJupyterExperimentPlan(args);
const scenarios = [];

for (const failurePoint of ["type", "enter", "after-enter", "none"]) {
  const token = randomUUID();
  const experimentDirectory = `coldverify_start_${token}`;
  const jobId = `coldverify-start-${token}`;
  const jobPath = path.join(stateRoot, `${jobId}.json`);
  const intentPath = path.join(stateRoot, `${experimentDirectory}.intent.json`);
  const plan = { ...structuredClone(template), jobId, experimentDirectory };
  const events = [];
  let typed = 0;
  let entered = 0;
  let newTabs = 0;
  const backend = new SafeEdgeBackend();
  backend.buildJupyterExperimentPlan = async () => structuredClone(plan);
  const persistedState = async () => JSON.parse(await readFile(jobPath, "utf8"));
  const assertSubmitting = async (event) => {
    const persisted = await persistedState();
    assert.equal(persisted.jobId, jobId);
    assert.equal(persisted.state, "SUBMITTING", `${event} preceded durable SUBMITTING`);
    events.push(`${event}:SUBMITTING-persisted`);
  };
  const locator = {
    fill: async () => {},
    count: async () => 1,
    waitFor: async () => {},
    click: async () => {},
    filter() { return this; },
    first() { return this; },
  };
  const tab = {
    id: `mock-${token}`,
    markHandoff: async () => {},
    goto: async () => {},
    url: async () => args.jupyterUrl,
    title: async () => "mock terminal",
    playwright: {
      getByRole: () => locator,
      locator: () => locator,
      waitForTimeout: async () => {
        if (failurePoint === "after-enter") throw new Error("injected after-enter disconnect");
      },
    },
    cua: {
      type: async () => {
        await assertSubmitting("type");
        typed += 1;
        if (failurePoint === "type") throw new Error("injected type disconnect");
      },
      keypress: async ({ keys }) => {
        assert.deepEqual(keys, ["ENTER"]);
        await assertSubmitting("enter");
        entered += 1; // Simulate delivery before an uncertain transport failure.
        if (failurePoint === "enter") throw new Error("injected enter disconnect");
      },
    },
  };
  backend.edge = { tabs: { new: async () => { newTabs += 1; return tab; } } };

  try {
    if (failurePoint === "none") {
      const submitted = await backend.startJupyterExperiment(args);
      assert.equal(submitted.state, "SUBMITTED");
    } else {
      await assert.rejects(backend.startJupyterExperiment(args), /injected/u);
    }
    const saved = await persistedState();
    assert.equal(saved.state, failurePoint === "none" ? "SUBMITTED" : "SUBMITTING");
    assert.equal(typed, 1);
    assert.equal(entered, failurePoint === "type" ? 0 : 1);
    assert.equal(newTabs, 1);

    // A new backend models a bridge/computer restart: only disk state survives.
    const recovered = new SafeEdgeBackend();
    recovered.buildJupyterExperimentPlan = async () => ({
      ...structuredClone(plan), jobId: `coldverify-retry-${token}`,
    });
    recovered.edge = {
      tabs: { new: async () => { throw new Error("duplicate start touched browser"); } },
    };
    const duplicate = await recovered.startJupyterExperiment(args);
    assert.equal(duplicate.state, "ALREADY_REGISTERED");
    assert.equal(duplicate.jobId, jobId);
    assert.equal(entered, failurePoint === "type" ? 0 : 1);
    assert.equal(typed, 1);
    scenarios.push({ failurePoint, events, typed, entered, duplicateState: duplicate.state });
  } finally {
    for (const filename of [jobPath, intentPath, `${jobPath}.${process.pid}.tmp`]) {
      await unlink(filename).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

const fixture = await readFile(new URL("./fixtures/h204_status_snapshot.txt", import.meta.url), "utf8");
const parsed = parseJupyterJsonSnapshot(fixture);
assert.equal(parsed.state, "PASS");
assert.equal(parsed.stage, "complete");
assert.equal(parsed.values.job_id, "h204-synthetic-fixture");
assert.equal(parsed.values.updated_at, "2026-09-03T07:17:46+0800");
assert.equal(parsed.progress.completed, 25);
assert.equal(parsed.progress.total, 25);
assert.equal(parsed.values.audit_ok, true);
assert.equal(parsed.values.bundle_bytes, 611696);
assert.match(parsed.runRoot, /\/probe25_20260903_071628$/u);
assert.match(parsed.bundle, /\/H204_kv_anchor_policy_probe25_20260903_071742_bundle\.zip$/u);
assert.ok(!parsed.runRoot.includes('"'));
assert.ok(!parsed.bundle.includes('"'));

console.log(JSON.stringify({
  passed: true,
  scenarios,
  syntheticSnapshot: { jobId: parsed.values.job_id, state: parsed.state,
    completed: parsed.progress.completed, total: parsed.progress.total,
    auditOk: parsed.values.audit_ok, bundleBytes: parsed.values.bundle_bytes },
  browserOrServerAccess: false,
  testStateRecordsRemoved: true,
}, null, 2));

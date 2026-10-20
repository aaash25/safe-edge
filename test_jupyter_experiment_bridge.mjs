import assert from "node:assert/strict";
import path from "node:path";
import { SafeEdgeBackend } from "./safe_edge_bridge_mcp.mjs";
import { parseJupyterJsonSnapshot } from "./jupyter_experiment_helpers.mjs";
const backend = new SafeEdgeBackend();
const archive = path.resolve(process.argv[2] || "fixtures/source.zip");
const plan = await backend.buildJupyterExperimentPlan({ jupyterUrl: "http://aic.bnu.edu.cn/jupyter-forward/test/lab",
  sourceZip: archive, bundleGlob: "H204_*_bundle.zip", waitSeconds: 900,
  downloadDirectory: path.resolve("test-downloads") });
assert.equal(plan.state, "PLANNED");
const saves = [];
backend.saveExperimentJob = async (job) => saves.push(structuredClone(job));
backend.loadExperimentJob = async () => structuredClone(plan);
let navigated;
const snapshot = (state = "RUNNING", age = 0, id = plan.jobId) => '- main:\n  - tabpanel "status.json":\n    - list:\n      - generic: "root:"\n      - list:\n' + Object.entries({job_id: id, state, updated_at: new Date(Date.now() - age).toISOString(), completed: 5, total: 25}).map(([k,v]) => `        - generic: ${JSON.stringify(k+":")}\n        - generic: ${JSON.stringify(v)}\n`).join("");
let view = snapshot();
const tab = { id: "new-tab", markHandoff: async () => {}, goto: async (url) => { navigated = url; },
  url: async () => navigated, playwright: { waitForTimeout: async () => {}, domSnapshot: async () => view,
    getByRole: () => ({waitFor: async () => {}, click: async () => {}}) } };
backend.edge = { tabs: { new: async () => tab, get: async () => { throw new Error("old tab from reboot"); } } };
let result = await backend.statusJupyterExperiment(plan.jobId, {jupyterUrl:"http://aic.bnu.edu.cn/jupyter-forward/new-instance/lab"});
assert.equal(result.state, "RUNNING");
assert.match(navigated, /new-instance\/lab\/tree/u);
view = snapshot("RUNNING", 240000);
backend.loadExperimentJob = async () => ({...structuredClone(plan), lastHeartbeat: parseJupyterJsonSnapshot(view).values.updated_at, heartbeatObservedAt: new Date(Date.now()-240000).toISOString()});
result = await backend.statusJupyterExperiment(plan.jobId);
assert.equal(result.state, "STALE");
view = snapshot("PASS", 0, "wrong-job");
await assert.rejects(backend.statusJupyterExperiment(plan.jobId), /job_id mismatch/u);
backend.loadExperimentJob = async () => ({...plan, state: "PASS", localBundle: archive, localBundleCrcOk: true});
backend.edge = null; // Local cached result must work without a browser/server.
result = await backend.downloadJupyterExperiment(plan.jobId);
assert.equal(result.cached, true);
assert.equal(result.crcOk, true);
backend.loadExperimentJob = async () => ({...plan, state: "PASS", localBundle: archive, localBundleCrcOk: true, bundleBytes: 611696});
await assert.rejects(backend.downloadJupyterExperiment(plan.jobId), /byte count differs/u);
assert.ok(saves.length > 0);
console.log(JSON.stringify({passed:true, checks:["plan without browser", "rebind URL", "stale heartbeat", "job identity", "offline cached download"]}));

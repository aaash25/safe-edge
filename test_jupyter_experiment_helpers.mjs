import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildControllerSource, buildRemoteLaunchCommand, copyDownloadedFile,
  chooseDownloadDestination, globToRegExp, inspectZip, normalizeJupyterBaseUrl,
  parseJupyterJsonSnapshot, recommendNextCheck, runProcess, validateJobId,
  validateBundleGlob } from "./jupyter_experiment_helpers.mjs";

const source = await inspectZip(path.resolve(process.argv[2] || "fixtures/source.zip"));
const plan = { jobId: "h204-local-test", experimentDirectory: source.experiment_directory,
  entrypoint: source.entrypoint, sourceName: path.basename(source.path), sourceBytes: source.bytes,
  bundleGlob: "H204_*_bundle.zip" };
assert.equal(source.crc_ok, true);
assert.equal(source.members, 7);
assert.match(source.entrypoint, /^launch_h\d+\.py$/u);
assert.equal(normalizeJupyterBaseUrl("http://aic.bnu.edu.cn/jupyter-forward/demo/lab/tree/project"), "http://aic.bnu.edu.cn/jupyter-forward/demo");
for (const value of ["..", ".", "../job", "a/b", "-bad"]) assert.throws(() => validateJobId(value));
assert.throws(() => normalizeJupyterBaseUrl("http://evil.test/jupyter-forward/x/lab"));
assert.throws(() => normalizeJupyterBaseUrl("http://aic.bnu.edu.cn/notebooks"));
assert.throws(() => validateBundleGlob("../*.zip"));
assert.throws(() => validateBundleGlob("*"));
assert.ok(globToRegExp(plan.bundleGlob).test("H204_new_bundle.zip"));
const command = buildRemoteLaunchCommand(plan);
assert.match(command, /&& \{ nohup /u);
assert.match(command, /mkdir '[^']+h204-local-test' &&/u);
assert.throws(() => buildRemoteLaunchCommand({ ...plan, jobId: ".." }));
const pythonSource = buildControllerSource(plan);
assert.match(pythonSource, /hf-mirror\.com/u);
const temp = await mkdtemp(path.join(os.tmpdir(), "experiment-tests-"));
const generated = path.join(temp, "controller.py");
await writeFile(generated, pythonSource, "utf8");
await runProcess("python", ["-c", "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')", generated]);

function snapshot(values) {
  return '- main:\n  - tabpanel "status.json":\n    - region "notebook content":\n      - list:\n        - generic: "root:"\n        - list:\n' + Object.entries(values).map(([k, v]) => `          - generic: ${JSON.stringify(k + ":")}\n          - generic: ${JSON.stringify(v)}\n`).join("") +
    '          - generic: "nested:"\n          - list:\n            - generic: "state:"\n            - generic: "FAILED"\n- contentinfo:\n  - generic: "state:"\n  - generic: "FAILED"';
}
const now = Date.now();
const parsed = parseJupyterJsonSnapshot(snapshot({ job_id: plan.jobId, state: "RUNNING", stage: "launch", completed: 10, total: 25, updated_at: new Date(now).toISOString() }));
assert.equal(parsed.state, "RUNNING");
assert.equal(parsed.progress.completed, 10);
assert.equal(recommendNextCheck(null, parsed, 1800, now), 1800);
assert.equal(recommendNextCheck({ completed: 5, updatedAt: new Date(now - 300000).toISOString() }, parsed, 1800, now), 660);
assert.equal(recommendNextCheck(null, parsed, 1800, now + 240000), 1800); // Clock skew is not a stale heartbeat.
assert.equal(parseJupyterJsonSnapshot(snapshot({state: '"RUNNING"', completed: "25", total: "25"})).progress.completed, 25);
assert.throws(() => parseJupyterJsonSnapshot("H204 PASS"));
assert.throws(() => parseJupyterJsonSnapshot(snapshot({ state: "garbage" })));

const destination = await chooseDownloadDestination(temp, "result.zip");
await copyDownloadedFile(source.path, destination);
assert.match(await chooseDownloadDestination(temp, "result.zip"), /result \(1\)\.zip$/u);
await assert.rejects(copyDownloadedFile(source.path, destination), /EEXIST/u);
await assert.rejects(chooseDownloadDestination(temp, "../escape.zip"));
console.log(JSON.stringify({ passed: true, source: source.path, bytes: source.bytes, members: source.members,
  checks: ["source CRC", "input boundaries", "grouped shell/exclusive job", "generated Python compile", "JSON root scope", "dynamic cadence", "stale heartbeat", "exclusive download"] }, null, 2));

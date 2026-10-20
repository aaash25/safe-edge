import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { SafeEdgeBackend } from "./safe_edge_bridge_mcp.mjs";
import { inspectZip } from "./jupyter_experiment_helpers.mjs";

const calls = [];
const tab = {
  id: "host-tab",
  markHandoff: async () => calls.push(["markHandoff"]),
  goto: async (url) => calls.push(["goto", url]),
  url: async () => "about:blank",
  close: async () => { throw new Error("Must not close test tab"); },
  playwright: {
    domSnapshot: async () => "- textbox: hello",
    locator: (selector) => ({
      click: async (options) => calls.push(["click", selector, options]),
      fill: async (text, options) => calls.push(["fill", selector, text, options]),
    }),
  },
  cua: {
    keypress: async (options) => calls.push(["keypress", options]),
    type: async (options) => calls.push(["type", options]),
  },
};
const edge = {
  tabs: { new: async () => { calls.push(["new"]); return tab; } },
  user: { openTabs: async () => [{ id: tab.id, title: "Blank", url: "about:blank" }] },
};
const agent = { browsers: {} };
const initialRuntime = globalThis.nodeRepl;
const initialDisplay = globalThis.display;
const backend = new SafeEdgeBackend({ hostRuntime: { agent, edge } });

// Fail before initialize on old code: that route starts an external app-server.
assert.equal(backend.runtimeMode, "host");
await backend.initialize();
assert.equal(backend.agent, agent);
assert.equal(backend.edge, edge);
assert.equal(backend.appServer, undefined);
assert.equal(globalThis.nodeRepl, initialRuntime);
assert.equal(globalThis.display, initialDisplay);
assert.deepEqual(calls, [], "Host initialize must not name a session or use the network");

const resultValue = (result) => JSON.parse(result.content[0].text);
assert.equal(resultValue(await backend.callTool("list_tabs", {}))[0].id, tab.id);
assert.equal(resultValue(await backend.callTool("new_tab", {})).tab, tab.id);
assert.deepEqual(calls.splice(0), [["new"], ["markHandoff"]]);
await backend.callTool("click", { tab: tab.id, selector: "input" });
await backend.callTool("fill", { tab: tab.id, selector: "input", text: "hello" });
await backend.callTool("keypress", { tab: tab.id, keys: ["TAB"] });
await backend.callTool("type_text", { tab: tab.id, text: "world" });
assert.ok(calls.some(([name, selector]) => name === "click" && selector === "input"));
assert.ok(calls.some(([name, selector, value]) => name === "fill" && selector === "input" && value === "hello"));
assert.ok(calls.some(([name, options]) => name === "keypress" && options.keys[0] === "TAB"));
assert.ok(calls.some(([name, options]) => name === "type" && options.text === "world"));

const failures = [
  "Browser request-header policy requires caller identity.",
  "nodeRepl.fetch request failed",
  "Browser permission denied",
  "native pipe closed",
];
for (const message of failures) {
  let attempts = 0;
  edge.user.openTabs = async () => { attempts += 1; throw new Error(message); };
  await assert.rejects(backend.callTool("list_tabs", {}), (error) => error.message === message);
  assert.equal(attempts, 1, "Host failures must not restart or replace the runtime");
}
let closed = false;
backend.appServer = { close: () => { closed = true; } };
await assert.rejects(backend.reconnect(), /Host browser runtime must be recovered by its caller/u);
backend.serverClosed();
assert.equal(closed, false);
assert.equal(globalThis.nodeRepl, initialRuntime);
assert.equal(globalThis.display, initialDisplay);

await assert.rejects(backend.callTool("navigate", { tab: tab.id, url: "file:///C:/secret" }), /Only HTTP\(S\)/u);
await assert.rejects(backend.callTool("upload_files", { tab: tab.id, selector: "input", files: ["C:/Windows/win.ini"] }), /outside the allowed local roots/u);
assert.throws(() => new SafeEdgeBackend({ hostRuntime: { agent } }), /agent and edge/u);
assert.equal(new SafeEdgeBackend().runtimeMode, "standalone");
const standalone = new SafeEdgeBackend();
standalone.edge = { user: { openTabs: async () => [] } };
const ended = [];
const removeEnded = (() => {
  const handler = { run: async (metadata) => ended.push(metadata) };
  standalone.turnEndedHandlers.add(handler);
  return () => standalone.turnEndedHandlers.delete(handler);
})();
await standalone.callTool("list_tabs", {});
assert.deepEqual(ended, [], "Tool calls must retain the long-lived standalone turn");
removeEnded();
await standalone.callTool("list_tabs", {});
assert.equal(ended.length, 0, "Removed turn-ended handlers must not run");
// The app's JS host does not expose a process global. Importing/constructing
// its bridge must not load the standalone MCP entry point or invent an ID.
const initialProcess = globalThis.process;
const fixtureJob = { jobId: `host-compat-test-${randomUUID()}`, state: "PLANNED" };
const fixtureJobDirectory = path.join(os.tmpdir(), "safe-edge-experiment-jobs");
const fixtureJobPath = `${fixtureJobDirectory}/${fixtureJob.jobId}.json`;
const sourceZip = fileURLToPath(new URL("./fixtures/source.zip", import.meta.url));
try {
  globalThis.process = undefined;
  const { SafeEdgeBackend: EmbeddedBackend } = await import("./safe_edge_bridge_mcp.mjs?without-process");
  const embedded = new EmbeddedBackend({ hostRuntime: { agent, edge } });
  await embedded.initialize();
  assert.equal(embedded.runtimeMode, "host");
  assert.equal(embedded.sessionId, undefined);
  const localChecks = await Promise.allSettled([
    (async () => {
      await embedded.saveExperimentJob(fixtureJob);
      assert.deepEqual(await embedded.loadExperimentJob(fixtureJob.jobId), fixtureJob);
      const updatedJob = { ...fixtureJob, state: "RUNNING" };
      await embedded.saveExperimentJob(updatedJob);
      assert.deepEqual(await embedded.loadExperimentJob(fixtureJob.jobId), updatedJob);
      assert.deepEqual((await readdir(fixtureJobDirectory)).filter((name) => name.startsWith(fixtureJob.jobId)),
        [`${fixtureJob.jobId}.json`], "Atomic save must not leave temporary files");
      await assert.rejects(embedded.loadExperimentJob("../outside"), /invalid experiment job id/u);
    })(),
    (async () => {
      const archive = await inspectZip(sourceZip);
      assert.equal(archive.crc_ok, true);
      assert.ok(archive.bytes > 0);
      assert.equal(archive.entrypoint, "launch_h204.py");
    })(),
  ]);
  assert.deepEqual(localChecks.map((result) => result.status === "fulfilled" ? "PASS" : String(result.reason)), ["PASS", "PASS"],
    "Job persistence and ZIP inspection must also work without a process global");
} finally {
  globalThis.process = initialProcess;
  await unlink(fixtureJobPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
console.log(JSON.stringify({ passed: true, checks: ["host injection", "no runtime or process mutation", "new tab retained", "click/fill/keyboard forwarding", "fail closed without restart", "URL and upload boundaries", "standalone default preserved", "turn-ended compatibility", "job persistence without process", "ZIP inspection without process"], browserOrServerAccess: false, testJobRemoved: true }));

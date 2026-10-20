import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { SafeEdgeBackend } = await import(process.env.SAFE_EDGE_TEST_BRIDGE
  ? pathToFileURL(process.env.SAFE_EDGE_TEST_BRIDGE).href
  : "./safe_edge_bridge_mcp.mjs");

test("a failed reconnect does not strand subsequent calls with an undefined browser", async () => {
  const backend = new SafeEdgeBackend();
  const tabs = [{ id: "recovered-tab" }];
  backend.edge = { user: { openTabs: async () => { throw new Error("native pipe closed"); } } };
  let attempts = 0;
  backend.initialize = async () => {
    attempts++;
    if (attempts === 1) throw new Error("Codex app-server exited with code 1");
    backend.edge = { user: { openTabs: async () => tabs } };
  };
  await assert.rejects(backend.callTool("list_tabs", {}), /app-server exited with code 1/);
  const result = await backend.callTool("list_tabs", {});
  assert.deepEqual(JSON.parse(result.content[0].text), tabs);
  assert.equal(attempts, 2);
});

test("concurrent reconnect requests share one initialization", async () => {
  const backend = new SafeEdgeBackend();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let attempts = 0;
  let closes = 0;
  backend.appServer = { close: () => { closes++; } };
  backend.initialize = async () => {
    attempts++;
    await gate;
    backend.edge = { user: { openTabs: async () => [] } };
  };
  const first = backend.reconnect();
  const second = backend.reconnect();
  release();
  await Promise.all([first, second]);
  assert.equal(attempts, 1);
  assert.equal(closes, 1);
});

test("calls arriving during reconnect wait for the replacement browser", async () => {
  const backend = new SafeEdgeBackend();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  backend.initialize = async () => {
    await gate;
    backend.edge = { user: { openTabs: async () => [{ id: "ready" }] } };
  };
  const recovering = backend.reconnect();
  const resultPromise = backend.callTool("list_tabs", {});
  release();
  const [, result] = await Promise.all([recovering, resultPromise]);
  assert.equal(JSON.parse(result.content[0].text)[0].id, "ready");
});

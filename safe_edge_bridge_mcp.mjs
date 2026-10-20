import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  JUPYTER_REPO_PATH,
  SERVER_REPO,
  buildRemoteLaunchCommand,
  canCollectResult,
  chooseDownloadDestination,
  copyDownloadedFile,
  encodeJupyterPath,
  globToRegExp,
  inspectZip,
  makeJobId,
  normalizeJupyterBaseUrl,
  parseJupyterJsonSnapshot,
  recommendNextCheck,
  resultProtocolFor,
  validateBundleGlob,
  validateDownloadDirectory,
  validateJobId,
  validateWaitSeconds,
} from "./jupyter_experiment_helpers.mjs";

const env = typeof process !== "undefined" ? process.env : {};
const CODEX_HOME = env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_APP_ROOT = env.SAFE_EDGE_CODEX_APP_ROOT ||
  path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "OpenAI/Codex");

async function findNewestVersionedFile(root, relativeFile) {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const file = path.join(directory, relativeFile);
    try {
      const [directoryInfo, fileInfo] = await Promise.all([
        stat(directory),
        stat(file),
      ]);
      if (fileInfo.isFile()) {
        candidates.push({ directory, file, mtimeMs: directoryInfo.mtimeMs });
      }
    } catch {
      // Ignore stale version directories that do not contain the required file.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`Cannot find ${relativeFile} under ${root}`);
  }
  return candidates[0].file;
}

const CODEX_EXE = await findNewestVersionedFile(
  path.join(CODEX_APP_ROOT, "bin"),
  "codex.exe",
);
const PLAYWRIGHT_MCP_SERVER = await findNewestVersionedFile(
  path.join(CODEX_APP_ROOT, "runtimes/cua_node"),
  "bin/node_modules/playwright/lib/mcp/sdk/server.js",
);
const BROWSER_CLIENT = await findNewestVersionedFile(
  path.join(CODEX_HOME, "plugins/cache/openai-bundled/browser"),
  "scripts/browser-client.mjs",
);
const BROWSER_PLUGIN_VERSION = path.basename(
  path.dirname(path.dirname(BROWSER_CLIENT)),
);
const BROWSER_SERVICE = path.join(
  path.dirname(BROWSER_CLIENT),
  "browser-service.mjs",
);
const WORKSPACE_ROOT = path.resolve(env.SAFE_EDGE_WORKSPACE_ROOT || path.dirname(fileURLToPath(import.meta.url)));
const TEMP_ROOT = os.tmpdir();
const JOB_STATE_ROOT = path.join(TEMP_ROOT, "safe-edge-experiment-jobs");
const CODEX_AUTH_JSON = path.join(CODEX_HOME, "auth.json");

let codexAuthCache;

async function loadCodexAuthTokens() {
  if (codexAuthCache && Date.now() - codexAuthCache.readAt < 300_000) {
    return codexAuthCache.tokens;
  }
  const tokens = JSON.parse(await readFile(CODEX_AUTH_JSON, "utf8")).tokens;
  if (!tokens?.access_token) throw new Error("Codex auth.json has no access token");
  codexAuthCache = { readAt: Date.now(), tokens };
  return tokens;
}

// The browser runtime resolves caller identity and Statsig policy through
// nodeRepl.fetch. Inside the app that fetch already carries the signed-in
// user's OAuth token, so the standalone bridge must honour the same
// contract: attach the real token from auth.json instead of fabricating an
// identity or bypassing the check.
async function authenticatedRuntimeFetch(input, init) {
  let url;
  try {
    const raw = input instanceof Request ? input.url : input;
    if (typeof raw === "string" || raw instanceof URL) url = new URL(raw);
  } catch {
    // Not URL-shaped input; let globalThis.fetch report the precise error.
  }
  if (url?.origin === "https://chatgpt.com") {
    const tokens = await loadCodexAuthTokens();
    // Mirror the header set the in-app Rust nodeRepl.fetch sends on its
    // allow-listed routes: it strips caller headers and attaches exactly the
    // auth, originator and account headers. Extra undici defaults (accept,
    // user-agent) trip chatgpt.com's edge policy.
    const headers = new Headers();
    headers.set("authorization", `Bearer ${tokens.access_token}`);
    headers.set("originator", "codex_browser_use");
    if (tokens.account_id) headers.set("chatgpt-account-id", tokens.account_id);
    return await globalThis.fetch(url.href, { ...init, headers });
  }
  return globalThis.fetch(input, init);
}

class AppServerClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(CODEX_EXE, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // The Rust app-server logs ~4KB of INFO traces to stderr per JSON-RPC
    // request. Nobody reads that pipe here, so once the OS pipe buffer fills
    // the child blocks on its next log write and stops answering RPCs on
    // stdout — which is what stalled every origin-permission check (goto,
    // navigate) while createTab/closeTab kept working. Drain stderr.
    this.child.stderr.resume();
    this.child.once("exit", (code) => {
      const error = new Error(`Codex app-server exited with code ${code}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id == null) return;
      const waiter = this.pending.get(String(message.id));
      if (!waiter) return;
      this.pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  async start() {
    await this.request("initialize", {
      clientInfo: { name: "safe-edge-bridge-mcp", version: "0.2.1" },
      capabilities: { experimentalApi: true },
    });
  }

  request(method, params) {
    const id = String(this.nextId++);
    const operation = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return operation;
  }

  close() {
    this.child.stdin.end();
  }
}

function parseFlatToml(text) {
  const root = {};
  let target = root;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const section = line.match(/^\[([^\]]+)\]$/u);
    if (section) {
      target = root;
      for (const part of section[1].split(".")) target = target[part] ??= {};
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u);
    if (!assignment) throw new Error(`Unsupported TOML line: ${rawLine}`);
    const [, key, source] = assignment;
    let value;
    if (source === "true" || source === "false") value = source === "true";
    else if (/^-?\d+(?:\.\d+)?$/u.test(source)) value = Number(source);
    else value = JSON.parse(source);
    target[key] = value;
  }
  return root;
}

async function readBrowserToml(relativePath) {
  if (
    relativePath !== "browser/config.toml" &&
    !/^browser\/sessions\/[A-Za-z0-9_-]+\.toml$/u.test(relativePath)
  ) {
    throw new Error(`Safe Edge bridge refused TOML path: ${relativePath}`);
  }
  try {
    return parseFlatToml(
      await readFile(path.join(CODEX_HOME, ...relativePath.split("/")), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function connectNamedPipe(pipePath) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const onError = (error) => reject(error);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function validateUploadPaths(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("files must be a non-empty array");
  }
  const validated = [];
  for (const file of files) {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      throw new Error("Every upload path must be absolute");
    }
    const resolved = path.resolve(file);
    if (!isWithin(resolved, TEMP_ROOT) && !isWithin(resolved, WORKSPACE_ROOT)) {
      throw new Error(`Upload path is outside the allowed local roots: ${resolved}`);
    }
    if (!(await stat(resolved)).isFile()) throw new Error(`Not a file: ${resolved}`);
    validated.push(resolved);
  }
  return validated;
}

const toolDefinitions = [
  {
    name: "list_tabs",
    description: "List current user-owned Edge tabs without changing them.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "new_tab",
    description: "Create an Edge tab and optionally navigate to an HTTP(S) URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "close_tab",
    description: "Close one exact Edge tab after the user has explicitly requested cleanup.",
    inputSchema: {
      type: "object",
      properties: { tab: { type: "string" } },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description: "Navigate a claimed or MCP-created Edge tab to an HTTP(S) URL.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        url: { type: "string" },
      },
      required: ["tab", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot",
    description: "Return the current DOM snapshot for a tab.",
    inputSchema: {
      type: "object",
      properties: { tab: { type: "string" } },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_match",
    description: "Return small read-only DOM snapshot excerpts around an exact text pattern.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        pattern: { type: "string", minLength: 1 },
        contextLines: { type: "integer", minimum: 0, maximum: 20 },
        maxMatches: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["tab", "pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "visible_dom",
    description:
      "Return the lightweight visible interactive DOM and fresh node ids for a tab.",
    inputSchema: {
      type: "object",
      properties: { tab: { type: "string" } },
      required: ["tab"],
      additionalProperties: false,
    },
  },
  {
    name: "dom_click",
    description: "Click one fresh node id returned by visible_dom.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        node_id: { type: "string" },
      },
      required: ["tab", "node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click one exact Playwright-compatible selector in a tab.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        selector: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
      },
      required: ["tab", "selector"],
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Replace the value of one exact input selector.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
      },
      required: ["tab", "selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Send one keyboard key or key chord to an exact selector.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        selector: { type: "string" },
        key: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
      },
      required: ["tab", "selector", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "keypress",
    description: "Send a low-level key sequence to the current tab focus.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        keys: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["tab", "keys"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Insert an exact text string into the current tab focus.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        text: { type: "string" },
      },
      required: ["tab", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "click_at",
    description: "Click an exact point in the active tab viewport.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        x: { type: "number", minimum: 0 },
        y: { type: "number", minimum: 0 },
      },
      required: ["tab", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_files",
    description:
      "Click a selector that opens a file chooser, then upload absolute files from the workspace or the user's Temp directory.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        selector: { type: "string" },
        files: { type: "array", items: { type: "string" }, minItems: 1 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
      },
      required: ["tab", "selector", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_files_dom",
    description:
      "Click a fresh visible-DOM node that opens a file chooser, then upload absolute files from the workspace or the user's Temp directory.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        node_id: { type: "string" },
        files: { type: "array", items: { type: "string" }, minItems: 1 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
      },
      required: ["tab", "node_id", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "download_file",
    description:
      "Click an exact selector while capturing the browser download, then return the temporary local file path.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        selector: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      required: ["tab", "selector"],
      additionalProperties: false,
    },
  },
  {
    name: "download_file_dom",
    description:
      "Click a fresh visible-DOM node while capturing the browser download, then return the temporary local file path.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        node_id: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      required: ["tab", "node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "jupyter_experiment_plan",
    description:
      "Validate a source ZIP and infer the fixed AIC experiment directory and launcher without changing Edge or the server.",
    inputSchema: {
      type: "object",
      properties: {
        jupyterUrl: { type: "string" },
        sourceZip: { type: "string" },
        bundleGlob: { type: "string" },
        waitSeconds: { type: "integer", minimum: 60, maximum: 7200 },
        downloadDirectory: { type: "string" },
      },
      required: [
        "jupyterUrl",
        "sourceZip",
        "bundleGlob",
        "waitSeconds",
        "downloadDirectory",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "jupyter_experiment_start",
    description:
      "Upload one experiment ZIP to the authorized AIC repository, perform the lightweight size/entrypoint/GPU gates, and start its inferred launch_*.py in a persistent Edge terminal without closing anything.",
    inputSchema: {
      type: "object",
      properties: {
        jupyterUrl: { type: "string" },
        sourceZip: { type: "string" },
        bundleGlob: { type: "string" },
        waitSeconds: { type: "integer", minimum: 60, maximum: 7200 },
        downloadDirectory: { type: "string" },
      },
      required: [
        "jupyterUrl",
        "sourceZip",
        "bundleGlob",
        "waitSeconds",
        "downloadDirectory",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "jupyter_experiment_status",
    description:
      "Read the saved controller JSON for a job; report RUNNING/PASS/FAILED or STALE with a dynamic next-check interval. Optional jupyterUrl rebinds after a reset without restarting compute.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        jupyterUrl: { type: "string" },
        waitSeconds: { type: "integer", minimum: 60, maximum: 7200 },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "jupyter_experiment_download",
    description:
      "After PASS, download the exact bundle reported by the launcher and check ZIP CRC; return an already verified local copy even if the server is offline.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        jupyterUrl: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
];

const textResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function jobStatePath(jobId) {
  return path.join(JOB_STATE_ROOT, `${validateJobId(jobId)}.json`);
}

export class SafeEdgeBackend {
  constructor({ hostRuntime } = {}) {
    if (hostRuntime !== undefined && (!hostRuntime?.agent || !hostRuntime?.edge)) {
      throw new Error("Host browser runtime requires both agent and edge");
    }
    this.hostRuntime = hostRuntime;
    this.runtimeMode = hostRuntime === undefined ? "standalone" : "host";
    this.createdTabs = new Map();
    this.turnEndedHandlers = new Set();
    this.sessionId = this.runtimeMode === "host"
      ? undefined
      : `safe-edge-bridge-mcp-${process.pid}-${Date.now()}`;
  }

  async initialize() {
    if (this.runtimeMode === "host") {
      // The app owns identity, RPC, permissions and runtime lifecycle.
      // Never construct a replacement nodeRepl or start a second app-server.
      this.agent = this.hostRuntime.agent;
      this.edge = this.hostRuntime.edge;
      return;
    }
    this.appServer = new AppServerClient();
    await this.appServer.start();
    const metadata = () => ({
      session_id: this.sessionId,
      thread_id: this.sessionId,
      thread_source: "user",
      // One MCP server process = one long-lived Codex turn. Ending a turn
      // releases the extension-side tab leases, so per-tool-call turn ids
      // made every follow-up command fail with "No tab with id". A stable
      // turn id keeps the session attached until the pipe disconnects.
      turn_id: "mcp-session",
    });
    const appServer = this.appServer;
    // The 26.901+ browser runtime requires a real caller identity for every
    // extension request. Setting BROWSER_USE_DISABLE_AMBIENT_NETWORK used to
    // skip the identity bootstrap entirely, which made each tool call fail
    // with "Browser request-header policy requires caller identity." Keep
    // ambient network enabled so the runtime resolves the signed-in user's
    // identity and Statsig policy through authenticatedRuntimeFetch.
    let sentryUserId;
    try {
      sentryUserId = (await loadCodexAuthTokens()).account_id;
    } catch {
      // The runtime's own identity call will surface the precise failure.
    }
    globalThis.display = () => {};
    globalThis.nodeRepl = {
      cwd: process.cwd(),
      homeDir: os.homedir(),
      tmpDir: os.tmpdir(),
      platform: process.platform,
      env: {
        ...process.env,
        BROWSER_USE_AVAILABLE_BACKENDS: "chrome",
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
        BROWSER_USE_CODEX_APP_VERSION: BROWSER_PLUGIN_VERSION,
        BROWSER_USE_TINYSKY_ENABLED: "0",
        ...(sentryUserId ? { NODE_REPL_SENTRY_USER_ID: sentryUserId } : {}),
        CODEX_HOME,
      },
      get requestMeta() {
        return { "x-codex-turn-metadata": metadata() };
      },
      config: {
        readToml: readBrowserToml,
        writeToml() {
          throw new Error("Safe Edge bridge never writes browser permission state");
        },
        read: (options = {}) =>
          appServer.request("config/read", {
            cwd: options.cwd ?? process.cwd(),
            includeLayers: options.includeLayers ?? false,
          }),
        readRequirements: () =>
          appServer.request("configRequirements/read", null),
      },
      nativePipe: { createConnection: connectNamedPipe },
      createElicitation() {
        throw new Error(
          "Browser permission prompt required; change permissions in Codex rather than bypassing it",
        );
      },
      fetch: authenticatedRuntimeFetch,
      setResponseMeta() {},
      addAfterSubmittedCodeHook() {},
      addTurnEndedHandler: (handler) => {
        if (typeof handler?.run !== "function") {
          throw new TypeError("Turn-ended handler requires a run function");
        }
        this.turnEndedHandlers.add(handler);
        return () => this.turnEndedHandlers.delete(handler);
      },
      emitImage() {},
    };
    const browserService = await import(pathToFileURL(BROWSER_SERVICE).href);
    globalThis.nodeRepl.rpc = async (service, request) => {
      if (service !== "browser") throw new Error(`Unsupported service: ${service}`);
      return await browserService.handleRpc(request);
    };
    const { setupBrowserRuntime } = await import(pathToFileURL(BROWSER_CLIENT).href);
    this.agent = await setupBrowserRuntime();
    this.edge = await this.agent.browsers.get("edge");
    await this.edge.nameSession("🔧 安全 Edge MCP");
  }

  async reconnect() {
    if (this.runtimeMode === "host") {
      throw new Error("Host browser runtime must be recovered by its caller; no session or process was closed");
    }
    if (this.reconnectPromise) return await this.reconnectPromise;
    this.reconnectPromise = (async () => {
      try {
        this.appServer?.close();
      } catch {
        // The old app-server may already have disappeared.
      }
      this.appServer = undefined;
      this.agent = undefined;
      this.edge = undefined;
      this.createdTabs.clear();
      try {
        await this.initialize();
      } catch (error) {
        // Leave a retryable, uninitialized backend and preserve the cause.
        try { this.appServer?.close(); } catch { /* Already disconnected. */ }
        this.appServer = undefined;
        this.agent = undefined;
        this.edge = undefined;
        throw error;
      }
    })();
    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise = undefined;
    }
  }

  isRecoverableConnectionError(error) {
    const message = String(error?.message ?? error);
    return /native pipe closed|browser is not available|browser.*disconnect|ECONNRESET|EPIPE/iu.test(
      message,
    );
  }

  async buildJupyterExperimentPlan(args, createDownloadDirectory = false) {
    const [sourceZip] = await validateUploadPaths([args.sourceZip]);
    const source = await inspectZip(sourceZip, "source");
    const plan = {
      jobId: makeJobId(source.experiment_directory),
      jupyterBaseUrl: normalizeJupyterBaseUrl(args.jupyterUrl),
      sourceZip,
      sourceName: path.basename(sourceZip),
      sourceBytes: source.bytes,
      sourceMembers: source.members,
      sourceCrcOk: source.crc_ok,
      experimentDirectory: source.experiment_directory,
      entrypoint: source.entrypoint,
      remoteRepository: SERVER_REPO,
      remoteExperiment: `${SERVER_REPO}/route/hypotheses/${source.experiment_directory}`,
      bundleGlob: validateBundleGlob(args.bundleGlob),
      waitSeconds: validateWaitSeconds(args.waitSeconds),
      downloadDirectory: await validateDownloadDirectory(
        args.downloadDirectory,
        WORKSPACE_ROOT,
        createDownloadDirectory,
      ),
      state: "PLANNED",
      createdAt: new Date().toISOString(),
    };
    plan.resultProtocol = resultProtocolFor(plan);
    plan.remoteJobDirectory = `${SERVER_REPO}/codex_experiment_jobs/${plan.jobId}`;
    plan.remoteStatusFile = `${plan.remoteJobDirectory}/status.json`;
    plan.statusJupyterPath = `${JUPYTER_REPO_PATH}/codex_experiment_jobs/${plan.jobId}/status.json`;
    plan.launchCommand = buildRemoteLaunchCommand(plan);
    return plan;
  }

  async saveExperimentJob(job) {
    await mkdir(JOB_STATE_ROOT, { recursive: true });
    const destination = jobStatePath(job.jobId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  }

  async loadExperimentJob(jobId) {
    const validated = validateJobId(jobId);
    const job = JSON.parse(await readFile(jobStatePath(validated), "utf8"));
    if (job.jobId !== validated) throw new Error("saved job identity mismatch");
    return job;
  }

  async resolveExperimentTab(job) {
    const created = this.createdTabs.get(job.terminalTabId);
    if (created) return created;
    try {
      const tab = await this.edge.tabs.get(job.terminalTabId);
      this.createdTabs.set(tab.id, tab);
      return tab;
    } catch {
      const openTabs = await this.edge.user.openTabs();
      const info = openTabs.find(
        (item) => item.url === job.terminalTabUrl && item.title === job.terminalTabTitle,
      );
      if (!info) {
        throw new Error(`experiment terminal is not available for ${job.jobId}`);
      }
      const tab = await this.edge.user.claimTab(info);
      this.createdTabs.set(tab.id, tab);
      job.terminalTabId = tab.id;
      await this.saveExperimentJob(job);
      return tab;
    }
  }

  async registerExperimentJob(job) {
    // A persistent, exclusive intent record blocks duplicate start even after an uncertain Enter.
    await mkdir(JOB_STATE_ROOT, { recursive: true });
    const intentPath = path.join(JOB_STATE_ROOT, `${job.experimentDirectory}.intent.json`);
    try {
      await writeFile(intentPath, JSON.stringify({ jobId: job.jobId }), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(intentPath, "utf8"));
      return { jobId: existing.jobId, state: "ALREADY_REGISTERED", action: "Use status/download; no second launch was submitted." };
    }
    job.state = "PREPARING";
    await this.saveExperimentJob(job);
    return null;
  }

  async startJupyterExperiment(args) {
    const job = await this.buildJupyterExperimentPlan(args, true);
    const duplicate = await this.registerExperimentJob(job);
    if (duplicate) return duplicate;
    const repositoryUrl = `${job.jupyterBaseUrl}/lab/tree/${encodeJupyterPath(
      JUPYTER_REPO_PATH,
    )}`;
    const tab = await this.edge.tabs.new();
    this.createdTabs.set(tab.id, tab);
    await tab.markHandoff();
    await tab.goto(repositoryUrl);

    const filter = tab.playwright.getByRole("textbox", {
      name: "Filter files by name",
      exact: true,
    });
    await filter.fill(job.sourceName, { timeoutMs: 30_000 });
    let sourceRow = tab.playwright.getByRole("listitem", {
      name: new RegExp(`Name: ${escapeRegExp(job.sourceName)}(?: |$)`, "u"),
    });
    const alreadyUploaded = (await sourceRow.count()) > 0;
    if (!alreadyUploaded) {
      await filter.fill("", { timeoutMs: 10_000 });
      const chooserPromise = tab.playwright.waitForEvent("filechooser", {
        timeoutMs: 30_000,
      });
      const [chooser] = await Promise.all([
        chooserPromise,
        tab.playwright
          .getByRole("button", { name: "Upload Files", exact: true })
          .click({ timeoutMs: 30_000 }),
      ]);
      await chooser.setFiles([job.sourceZip], { timeoutMs: 60_000 });
      await filter.fill(job.sourceName, { timeoutMs: 30_000 });
      sourceRow = tab.playwright.getByRole("listitem", {
        name: new RegExp(`Name: ${escapeRegExp(job.sourceName)}(?: |$)`, "u"),
      });
      await sourceRow.waitFor({ state: "visible", timeoutMs: 60_000 });
    }
    await filter.fill("", { timeoutMs: 10_000 });

    await tab.playwright
      .getByRole("button", { name: /New Launcher/u })
      .click({ timeoutMs: 30_000 });
    const terminalCard = tab.playwright
      .locator('.jp-LauncherCard:has-text("Terminal")')
      .filter({ visible: true })
      .first();
    await terminalCard.waitFor({ state: "visible", timeoutMs: 30_000 });
    await terminalCard.click({ timeoutMs: 30_000 });
    const terminalInput = tab.playwright.locator(".xterm-helper-textarea").filter({ visible: true });
    await terminalInput.waitFor({ state: "visible", timeoutMs: 30_000 });
    await terminalInput.click({ timeoutMs: 10_000 });
    job.terminalTabId = tab.id;
    job.uploaded = !alreadyUploaded;
    job.state = "SUBMITTING";
    job.startedAt = new Date().toISOString();
    await this.saveExperimentJob(job);
    await tab.cua.type({ text: job.launchCommand });
    await tab.cua.keypress({ keys: ["ENTER"] });
    await tab.playwright.waitForTimeout(1_500);

    job.terminalTabId = tab.id;
    job.terminalTabUrl = await tab.url();
    job.terminalTabTitle = await tab.title();
    job.uploaded = !alreadyUploaded;
    job.state = "SUBMITTED";
    job.runRoot = null;
    job.bundle = null;
    await this.saveExperimentJob(job);
    return {
      jobId: job.jobId,
      state: job.state,
      sourceMembers: job.sourceMembers,
      sourceCrcOk: job.sourceCrcOk,
      uploaded: job.uploaded,
      experimentDirectory: job.experimentDirectory,
      entrypoint: job.entrypoint,
      terminalTab: job.terminalTabId,
      nextCheckSeconds: job.waitSeconds,
      remoteStatusFile: job.remoteStatusFile,
    };
  }

  async statusJupyterExperiment(jobId, options = {}) {
    const job = await this.loadExperimentJob(jobId);
    if (options.jupyterUrl) {
      job.jupyterBaseUrl = normalizeJupyterBaseUrl(options.jupyterUrl);
      job.statusTabId = null;
    }
    if (options.waitSeconds !== undefined) job.waitSeconds = validateWaitSeconds(options.waitSeconds);
    await this.saveExperimentJob(job);
    let tab = job.statusTabId ? this.createdTabs.get(job.statusTabId) : null;
    if (!tab && job.statusTabId) {
      try {
        tab = await this.edge.tabs.get(job.statusTabId);
      } catch {
        tab = null;
      }
    }
    const statusUrl = `${job.jupyterBaseUrl}/lab/tree/${encodeJupyterPath(
      job.statusJupyterPath,
    )}`;
    if (!tab) {
      tab = await this.edge.tabs.new();
      this.createdTabs.set(tab.id, tab);
      await tab.markHandoff();
      await tab.goto(statusUrl);
      job.statusTabId = tab.id;
      job.statusTabUrl = await tab.url();
    } else {
      await tab.markHandoff();
      await tab.reload();
    }
    await tab.playwright.waitForTimeout(800);
    // Browser refresh can restore a cached Jupyter document; explicitly reread this JSON from disk.
    await tab.playwright.getByRole("tabpanel", { name: "status.json", exact: true })
      .waitFor({ state: "visible", timeoutMs: 30_000 });
    await tab.playwright.getByRole("menuitem", { name: "File", exact: true }).click({ timeoutMs: 10_000 });
    await tab.playwright.getByRole("menuitem", { name: "Reload JSON File from Disk", exact: true })
      .click({ timeoutMs: 10_000 });
    let parsed;
    try {
      parsed = parseJupyterJsonSnapshot(
        await tab.playwright.domSnapshot(),
        "status.json",
      );
    } catch {
      await tab.playwright.waitForTimeout(1_500);
      parsed = parseJupyterJsonSnapshot(
        await tab.playwright.domSnapshot(),
        "status.json",
      );
    }
    return await this.recordExperimentStatus(job, parsed);
  }

  async recordExperimentStatus(job, parsed) {
    if (parsed.values.job_id !== job.jobId) throw new Error("remote status job_id mismatch");
    if (!Number.isFinite(Date.parse(parsed.values.updated_at))) throw new Error("remote heartbeat timestamp missing or invalid");
    const h219 = resultProtocolFor(job) === "h219_precision_v1" && job.resultProtocol === "h219_precision_v1";
    if (["COMPLETE", "PARTIAL"].includes(parsed.state) || parsed.values.artifact_ready === true) {
      const values = parsed.values;
      if (!h219 || values.result_protocol !== "h219_precision_v1" || values.artifact_ready !== true ||
          !parsed.bundle || path.posix.dirname(parsed.bundle) !== job.remoteExperiment ||
          !globToRegExp(job.bundleGlob).test(path.posix.basename(parsed.bundle)) ||
          parsed.runRoot !== `${job.remoteExperiment}/run_precision`) {
        throw new Error("H219 terminal artifact requires exact protocol and in-experiment paths");
      }
      if (["COMPLETE", "PARTIAL"].includes(parsed.state) && (values.summary_validated !== true ||
          !Number.isInteger(values.completed) || values.completed < 0 || values.completed > 4400 ||
          values.total !== 4400 || values.missing_units !== 4400-values.completed ||
          (parsed.state === "COMPLETE" && (values.completed !== 4400 || values.launcher_returncode !== 0)) ||
          (parsed.state === "PARTIAL" && values.completed === 4400))) {
        throw new Error("H219 completion counts or summary validation mismatch");
      }
    }
    if (h219 && parsed.state === "PASS") throw new Error("H219 does not use legacy audit PASS");
    if (parsed.state === "PASS" && (parsed.values.audit_ok !== true || !parsed.bundle ||
        path.posix.dirname(parsed.bundle) !== job.remoteExperiment ||
        !globToRegExp(job.bundleGlob).test(path.posix.basename(parsed.bundle)) ||
        !parsed.runRoot?.startsWith(`${job.remoteExperiment}/`))) {
      throw new Error("PASS requires audit_ok and exact in-experiment result paths");
    }
    // Server and PC clocks may differ. Liveness uses observed heartbeat changes, not clock age.
    const heartbeat = parsed.values.updated_at;
    const changed = heartbeat !== job.lastHeartbeat;
    if (changed || !job.heartbeatObservedAt) job.heartbeatObservedAt = new Date().toISOString();
    const stale = parsed.state === "RUNNING" && Date.now() - Date.parse(job.heartbeatObservedAt) > 180000;
    const nextCheckSeconds = stale ? null : recommendNextCheck(job.lastProgress, parsed, job.waitSeconds);
    job.lastHeartbeat = heartbeat;
    job.state = stale ? "STALE" : parsed.state;
    job.runRoot = parsed.runRoot ?? job.runRoot ?? null;
    job.bundle = parsed.bundle ?? job.bundle ?? null;
    job.bundleBytes = Number(parsed.values.bundle_bytes) || job.bundleBytes || null;
    if (h219) Object.assign(job, {artifactReady: parsed.values.artifact_ready === true,
      launcherReturncode: parsed.values.launcher_returncode ?? null,
      launcherStatus: parsed.values.launcher_status ?? null,
      missingUnits: parsed.values.missing_units ?? null, error: parsed.error});
    job.lastCheckedAt = new Date().toISOString();
    job.lastProgress = { ...parsed.progress, updatedAt: parsed.values.updated_at };
    await this.saveExperimentJob(job);
    return {
      jobId: job.jobId,
      state: job.state,
      runRoot: job.runRoot,
      bundle: job.bundle,
      stage: parsed.stage,
      progress: parsed.progress,
      error: parsed.error,
      nextCheckSeconds,
      ...(stale ? { action: "Heartbeat is stale; inspect/reset connection. Do not restart compute automatically." } : {}),
    };
  }

  async downloadJupyterExperiment(jobId, timeoutMs = 120_000, options = {}) {
    let job = await this.loadExperimentJob(jobId);
    if (job.localBundle && job.localBundleCrcOk) {
      const integrity = await inspectZip(job.localBundle, "result");
      if (job.bundleBytes && integrity.bytes !== job.bundleBytes) throw new Error("cached bundle byte count differs from server");
      if (resultProtocolFor(job) === "h219_precision_v1" && !canCollectResult(job)) throw new Error("H219 cached artifact is not a validated terminal archive");
      return { jobId, state: job.state, runRoot: job.runRoot, serverBundle: job.bundle,
        localBundle: job.localBundle, bytes: integrity.bytes, members: integrity.members,
        crcOk: integrity.crc_ok, cached: true };
    }
    if (!canCollectResult(job)) await this.statusJupyterExperiment(jobId, options);
    job = await this.loadExperimentJob(jobId);
    if (!canCollectResult(job)) throw new Error(`experiment ${jobId} has no validated terminal archive`);
    if (options.jupyterUrl) job.jupyterBaseUrl = normalizeJupyterBaseUrl(options.jupyterUrl);
    const directoryPath = `${JUPYTER_REPO_PATH}/route/hypotheses/${job.experimentDirectory}`;
    const directoryUrl = `${job.jupyterBaseUrl}/lab/tree/${encodeJupyterPath(
      directoryPath,
    )}`;
    const tab = await this.edge.tabs.new();
    this.createdTabs.set(tab.id, tab);
    await tab.markHandoff();
    await tab.goto(directoryUrl);

    const bundleName = job.bundle ? path.posix.basename(job.bundle) : null;
    if (!bundleName || path.posix.dirname(job.bundle) !== job.remoteExperiment) throw new Error("exact result bundle missing or outside experiment");
    const glob = globToRegExp(job.bundleGlob);
    const filter = tab.playwright.getByRole("textbox", {
      name: "Filter files by name",
      exact: true,
    });
    await filter.fill(bundleName, { timeoutMs: 30_000 });
    if (!bundleName || !glob.test(bundleName)) {
      throw new Error(`no result bundle matched ${job.bundleGlob}`);
    }

    const row = tab.playwright.getByRole("listitem", {
      name: new RegExp(`Name: ${escapeRegExp(bundleName)}(?: |$)`, "u"),
    });
    await row.waitFor({ state: "visible", timeoutMs: 60_000 });
    await row.click({ button: "right", timeoutMs: 30_000 });
    const downloadPromise = tab.playwright.waitForEvent("download", { timeoutMs });
    const [download] = await Promise.all([
      downloadPromise,
      tab.playwright
        .getByRole("menuitem", { name: "Download", exact: true })
        .click({ timeoutMs: 30_000 }),
    ]);
    const temporaryPath = await download.path({ timeoutMs });
    if (!temporaryPath) {
      throw new Error("browser download completed without a local path");
    }
    const destination = path.dirname(path.resolve(temporaryPath)) === path.resolve(job.downloadDirectory)
      ? path.resolve(temporaryPath)
      : await chooseDownloadDestination(job.downloadDirectory, bundleName);
    const integrity = await copyDownloadedFile(temporaryPath, destination);
    if (job.bundleBytes && integrity.bytes !== job.bundleBytes) throw new Error("downloaded bundle byte count differs from server");
    job.bundle = `${job.remoteExperiment}/${bundleName}`;
    job.localBundle = destination;
    job.localBundleMembers = integrity.members;
    job.localBundleCrcOk = integrity.crc_ok;
    job.downloadedAt = new Date().toISOString();
    await this.saveExperimentJob(job);
    return {
      jobId: job.jobId,
      state: job.state,
      runRoot: job.runRoot,
      serverBundle: job.bundle,
      localBundle: destination,
      bytes: integrity.bytes,
      members: integrity.members,
      crcOk: integrity.crc_ok,
    };
  }

  async listTools() {
    return toolDefinitions;
  }

  async resolveTab(tabToken) {
    const created = this.createdTabs.get(tabToken);
    if (created) return created;
    const openTabs = await this.edge.user.openTabs();
    const info = openTabs.find(
      (item) => item.providerTabId === tabToken || item.id === tabToken,
    );
    if (!info) throw new Error(`Edge tab is not available: ${tabToken}`);
    try {
      return await this.edge.user.claimTab(info);
    } catch (error) {
      // The extension leases each tab to exactly one browser session, and the
      // Codex app's own browser runtime usually already owns user tabs that
      // this bridge wants to control. The lease is keyed by session id (not
      // by pipe connection), so adopting the owning session id here lets the
      // bridge operate as the same logical Codex session instead of a
      // competing one — claimTab then succeeds as a same-session operation.
      const conflict = /already part of browser session ([\w-]+)/u.exec(
        String(error?.message ?? ""),
      );
      if (
        conflict &&
        this.runtimeMode === "standalone" &&
        conflict[1] !== this.sessionId
      ) {
        this.sessionId = conflict[1];
        return await this.edge.user.claimTab(info);
      }
      throw error;
    }
  }

  validateUrl(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only HTTP(S) navigation is allowed");
    }
    return parsed.href;
  }

  async callToolOnce(name, args) {
    if (name === "list_tabs") return textResult(await this.edge.user.openTabs());
    if (name === "new_tab") {
      const tab = await this.edge.tabs.new();
      this.createdTabs.set(tab.id, tab);
      // Keep the tab resumable in both modes: the extension may still hand
      // the tab off (e.g. after a navigation), and the handoff marker is what
      // lets activateTurn re-attach it instead of failing with
      // "No tab with id".
      await tab.markHandoff();
      if (args.url) await tab.goto(this.validateUrl(args.url));
      return textResult({ tab: tab.id, url: await tab.url() });
    }
    if (name === "jupyter_experiment_plan") {
      return textResult(await this.buildJupyterExperimentPlan(args, false));
    }
    if (name === "jupyter_experiment_start") {
      return textResult(await this.startJupyterExperiment(args));
    }
    if (name === "jupyter_experiment_status") {
      return textResult(await this.statusJupyterExperiment(args.jobId, args));
    }
    if (name === "jupyter_experiment_download") {
      return textResult(
        await this.downloadJupyterExperiment(args.jobId, args.timeoutMs ?? 120_000, args),
      );
    }
    const tab = await this.resolveTab(args.tab);
    if (name === "close_tab") {
      await tab.close();
      this.createdTabs.delete(args.tab);
      return textResult({ ok: true, tab: args.tab });
    }
    if (name === "navigate") {
      await tab.goto(this.validateUrl(args.url));
      return textResult({ tab: args.tab, url: await tab.url() });
    }
    if (name === "snapshot") {
      return textResult({ tab: args.tab, snapshot: await tab.playwright.domSnapshot() });
    }
    if (name === "snapshot_match") {
      const snapshot = await tab.playwright.domSnapshot();
      const lines = snapshot.split("\n");
      const contextLines = args.contextLines ?? 3;
      const maxMatches = args.maxMatches ?? 10;
      const matches = [];
      for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
        if (!lines[index].includes(args.pattern)) continue;
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length, index + contextLines + 1);
        matches.push({ line: index + 1, excerpt: lines.slice(start, end).join("\n") });
      }
      return textResult({ tab: args.tab, pattern: args.pattern, matches });
    }
    if (name === "visible_dom") {
      return textResult({ tab: args.tab, dom: await tab.dom_cua.get_visible_dom() });
    }
    if (name === "dom_click") {
      await tab.dom_cua.click({ node_id: args.node_id });
      return textResult({ ok: true });
    }
    const timeoutMs = args.timeoutMs ?? 10_000;
    if (name === "click") {
      await tab.playwright.locator(args.selector).click({ timeoutMs });
      return textResult({ ok: true });
    }
    if (name === "fill") {
      await tab.playwright.locator(args.selector).fill(args.text, { timeoutMs });
      return textResult({ ok: true });
    }
    if (name === "press") {
      await tab.playwright.locator(args.selector).press(args.key, { timeoutMs });
      return textResult({ ok: true });
    }
    if (name === "keypress") {
      await tab.cua.keypress({ keys: args.keys });
      return textResult({ ok: true });
    }
    if (name === "type_text") {
      await tab.cua.type({ text: args.text });
      return textResult({ ok: true, length: args.text.length });
    }
    if (name === "click_at") {
      await tab.cua.click({ x: args.x, y: args.y });
      return textResult({ ok: true });
    }
    if (name === "upload_files") {
      const files = await validateUploadPaths(args.files);
      const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs });
      // Attach a rejection handler immediately.  Chromium can reject the
      // chooser wait before a slow Jupyter click resolves; awaiting it only
      // afterwards turns that expected tool failure into an unhandled process
      // rejection and kills the whole MCP bridge.
      const [chooser] = await Promise.all([
        chooserPromise,
        tab.playwright.locator(args.selector).click({ timeoutMs }),
      ]);
      await chooser.setFiles(files, { timeoutMs });
      return textResult({ ok: true, files: files.map((file) => path.basename(file)) });
    }
    if (name === "upload_files_dom") {
      const files = await validateUploadPaths(args.files);
      const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs });
      const [chooser] = await Promise.all([
        chooserPromise,
        tab.dom_cua.click({ node_id: args.node_id }),
      ]);
      await chooser.setFiles(files, { timeoutMs });
      return textResult({ ok: true, files: files.map((file) => path.basename(file)) });
    }
    if (name === "download_file") {
      const downloadPromise = tab.playwright.waitForEvent("download", { timeoutMs });
      const [download] = await Promise.all([
        downloadPromise,
        tab.playwright.locator(args.selector).click({ timeoutMs }),
      ]);
      const filePath = await download.path({ timeoutMs });
      if (!filePath) throw new Error("Browser download completed without a local path");
      return textResult({ ok: true, path: filePath, file: path.basename(filePath) });
    }
    if (name === "download_file_dom") {
      const downloadPromise = tab.playwright.waitForEvent("download", { timeoutMs });
      const [download] = await Promise.all([
        downloadPromise,
        tab.dom_cua.click({ node_id: args.node_id }),
      ]);
      const filePath = await download.path({ timeoutMs });
      if (!filePath) throw new Error("Browser download completed without a local path");
      return textResult({ ok: true, path: filePath, file: path.basename(filePath) });
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  async callTool(name, args) {
    // A previous reconnect may have failed, or another call may still be
    // rebuilding the runtime. Wait before dereferencing or taking an action.
    if (this.runtimeMode === "standalone" && (!this.edge || this.reconnectPromise)) {
      await this.reconnect();
    }
    try {
      return await this.callToolOnce(name, args);
    } catch (error) {
      // Edge raises this native error when the tab's debugger is held by
      // ANOTHER client (an open DevTools window or a different extension's
      // chrome.debugger usage). The extension-side attach swallows the
      // "Another debugger" conflict, so every CDP command then fails in a
      // loop. Chromium offers no way to kick the other client off — surface
      // an actionable message instead of a raw hang.
      if (/Debugger (?:is not attached|unattached)/u.test(String(error?.message ?? ""))) {
        throw new Error(
          `Tab ${args?.tab ?? "(unknown)"} is occupied by another debugger client ` +
            `(an open DevTools/F12 window or another extension). Close that tab's ` +
            `DevTools or disable the conflicting extension, then retry. ` +
            `Underlying error: ${error.message}`,
        );
      }
      // A host connection error must not fall back to the standalone shim.
      if (this.runtimeMode === "host") throw error;
      const safeToRetry = new Set([
        "list_tabs",
        "snapshot",
        "snapshot_match",
        "visible_dom",
      ]);
      if (!safeToRetry.has(name) || !this.isRecoverableConnectionError(error)) {
        throw error;
      }
      await this.reconnect();
      return await this.callToolOnce(name, args);
    }
  }

  serverClosed() {
    if (this.runtimeMode === "host") return;
    this.appServer?.close();
  }
}

if (typeof process !== "undefined" && process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const require = createRequire(import.meta.url);
  const { start } = require(PLAYWRIGHT_MCP_SERVER);
  await start(
    {
      name: "Safe Edge Bridge",
      nameInConfig: "safe_edge_bridge",
      version: "0.2.1",
      create: () => new SafeEdgeBackend(),
    },
    {},
  );
}

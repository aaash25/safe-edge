import { spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const env = typeof process !== "undefined" ? process.env : {};
export const SERVER_ALLOWED_ROOT = env.SAFE_EDGE_SERVER_ALLOWED_ROOT || "/srv/research";
export const SERVER_REPO = env.SAFE_EDGE_SERVER_REPO || `${SERVER_ALLOWED_ROOT}/project`;
export const SERVER_PYTHON = env.SAFE_EDGE_SERVER_PYTHON || `${SERVER_REPO}/.venv/bin/python`;
export const JUPYTER_REPO_PATH = env.SAFE_EDGE_JUPYTER_REPO_PATH || "project";
export const DOMESTIC_HF_ENDPOINT = "https://hf-mirror.com";
export const DEFAULT_DOWNLOAD_ROOT = path.resolve(env.SAFE_EDGE_DOWNLOAD_ROOT || path.join(os.homedir(), "Downloads"));

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_BUNDLE_GLOB = /^[A-Za-z0-9._*?-]+$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const ZIP_INSPECTOR = String.raw`
import json
import pathlib
import re
import stat
import sys
import zipfile

archive = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
with zipfile.ZipFile(archive) as handle:
    bad = handle.testzip()
    if bad is not None:
        raise RuntimeError(f"ZIP CRC failed at {bad}")
    all_infos = handle.infolist()
    if len({i.filename for i in all_infos}) != len(all_infos):
        raise RuntimeError("duplicate ZIP member")
    for info in all_infos:
        member = pathlib.PurePosixPath(info.filename)
        if member.is_absolute() or ".." in member.parts or "\\" in info.filename or ":" in info.filename:
            raise RuntimeError(f"unsafe ZIP member: {info.filename}")
        if stat.S_ISLNK(info.external_attr >> 16):
            raise RuntimeError(f"ZIP symlink not allowed: {info.filename}")
    infos = [item for item in all_infos if not item.is_dir()]
    if not infos:
        raise RuntimeError("empty ZIP")
    names = [item.filename for item in infos]
    for name in names:
        member = pathlib.PurePosixPath(name)
        if member.is_absolute() or ".." in member.parts or "\\" in name:
            raise RuntimeError(f"unsafe ZIP member: {name}")
    payload = {
        "path": str(archive.resolve()),
        "bytes": archive.stat().st_size,
        "members": len(infos),
        "crc_ok": True,
    }
    if mode == "source":
        launchers = []
        for name in names:
            match = re.fullmatch(
                r"route/hypotheses/([^/]+)/(launch_[A-Za-z0-9._-]+\.py)",
                name,
            )
            if match:
                launchers.append((match.group(1), match.group(2)))
        if len(launchers) != 1:
            raise RuntimeError(
                f"expected exactly one route/hypotheses/<experiment>/launch_*.py, found {launchers}"
            )
        payload["experiment_directory"], payload["entrypoint"] = launchers[0]
        prefix = f"route/hypotheses/{payload['experiment_directory']}/"
        if any(not name.startswith(prefix) for name in names):
            raise RuntimeError("source ZIP contains files outside its inferred experiment directory")
    print(json.dumps(payload, ensure_ascii=True))
`;

export function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `process exited with code ${code}`));
    });
  });
}

export async function inspectZip(archive, mode = "source") {
  if (mode !== "source" && mode !== "result") {
    throw new Error(`unsupported ZIP inspection mode: ${mode}`);
  }
  const resolved = path.resolve(archive);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`not a file: ${resolved}`);
  const python = (typeof process !== "undefined" && process.env?.PYTHON) || "python";
  const { stdout } = await runProcess(
    python,
    ["-c", ZIP_INSPECTOR, resolved, mode],
    { cwd: path.dirname(resolved) },
  );
  return JSON.parse(stdout.trim());
}

export function normalizeJupyterBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Jupyter URL must use HTTP(S)");
  }
  if (url.hostname.toLowerCase() !== "aic.bnu.edu.cn" || url.username || url.password) {
    throw new Error(`unexpected Jupyter host: ${url.hostname}`);
  }
  const labIndex = url.pathname.indexOf("/lab");
  if (labIndex >= 0) url.pathname = url.pathname.slice(0, labIndex);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!/^\/jupyter-forward\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(url.pathname)) {
    throw new Error("Jupyter URL does not contain one exact jupyter-forward instance path");
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/u, "");
}

export function validateBundleGlob(value) {
  if (typeof value !== "string" || !SAFE_BUNDLE_GLOB.test(value) || !value.endsWith(".zip")) {
    throw new Error("bundleGlob may contain only a filename glob without directories");
  }
  return value;
}

export function validateWaitSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 7200) {
    throw new Error("waitSeconds must be an integer from 60 to 7200");
  }
  return seconds;
}

export function validateJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value) || value.length > 100) {
    throw new Error("invalid experiment job id");
  }
  return value;
}

export async function validateDownloadDirectory(directory, workspaceRoot, create = true) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("downloadDirectory must be an absolute local path");
  }
  const resolved = path.resolve(directory);
  const allowed = [DEFAULT_DOWNLOAD_ROOT, path.resolve(workspaceRoot)];
  if (!allowed.some((root) => isWithin(resolved, root))) {
    throw new Error(`download directory is outside the allowed local roots: ${resolved}`);
  }
  if (create) await mkdir(resolved, { recursive: true });
  return resolved;
}

export function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function encodeJupyterPath(relativePath) {
  return relativePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function resultProtocolFor(plan) {
  return plan.experimentDirectory === "v527_h219_smolvlm_mlpq_precision_pope300_hr800" &&
    plan.entrypoint === "launch_h219.py" ? "h219_precision_v1" : "audited_pass_v1";
}

export function canCollectResult(job) {
  if (!job.bundle || path.posix.dirname(job.bundle) !== job.remoteExperiment ||
      !globToRegExp(job.bundleGlob).test(path.posix.basename(job.bundle))) return false;
  if (resultProtocolFor(job) !== "h219_precision_v1") return job.state === "PASS";
  return job.resultProtocol === "h219_precision_v1" && job.artifactReady === true &&
    ["COMPLETE", "PARTIAL", "FAILED"].includes(job.state) &&
    job.runRoot === `${job.remoteExperiment}/run_precision`;
}

export function buildControllerSource(plan) {
  validateJobId(plan.jobId);
  validateBundleGlob(plan.bundleGlob);
  if (![plan.experimentDirectory, plan.entrypoint, plan.sourceName].every((v) => typeof v === "string" && SAFE_COMPONENT.test(v))) throw new Error("unsafe server path");
  if (!Number.isSafeInteger(plan.sourceBytes) || plan.sourceBytes <= 0) throw new Error("invalid source ZIP size");
  const config = {
    allowed_root: SERVER_ALLOWED_ROOT, repository: SERVER_REPO, python: SERVER_PYTHON,
    source: `${SERVER_REPO}/${plan.sourceName}`, source_bytes: plan.sourceBytes,
    experiment: `${SERVER_REPO}/route/hypotheses/${plan.experimentDirectory}`,
    entrypoint: plan.entrypoint, bundle_glob: plan.bundleGlob, job_id: plan.jobId,
    result_protocol: resultProtocolFor(plan),
    job_root: `${SERVER_REPO}/codex_experiment_jobs/${plan.jobId}`, hf_endpoint: DOMESTIC_HF_ENDPOINT,
  };
  const script = readFileSync(new URL("./experiment_controller.py", import.meta.url), "utf8");
  return `import json\nCONFIG = json.loads(${JSON.stringify(JSON.stringify(config))})\n${script}`;
}

export function buildRemoteLaunchCommand(plan) {
  const directory = plan.experimentDirectory;
  const entrypoint = plan.entrypoint;
  const sourceName = plan.sourceName;
  if (![directory, entrypoint, sourceName].every((part) => SAFE_COMPONENT.test(part))) {
    throw new Error("unsafe source-derived server path component");
  }
  const expectedBytes = Number(plan.sourceBytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error("invalid source ZIP size");
  }
  const jobDirectory = `${SERVER_REPO}/codex_experiment_jobs/${plan.jobId}`;
  const controllerPath = `${jobDirectory}/controller.py`;
  const consolePath = `${jobDirectory}/controller.console.log`;
  const pidPath = `${jobDirectory}/controller.pid`;
  const encoded = Buffer.from(buildControllerSource(plan), "utf8").toString("base64");
  return [
    `cd ${shellQuote(SERVER_REPO)}`,
    `test "$(pwd -P)" = ${shellQuote(SERVER_REPO)}`,
    `test ! -L ${shellQuote(`${SERVER_REPO}/codex_experiment_jobs`)}`,
    `mkdir -p ${shellQuote(`${SERVER_REPO}/codex_experiment_jobs`)}`,
    `mkdir ${shellQuote(jobDirectory)}`,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(controllerPath)}`,
    `{ nohup ${shellQuote(SERVER_PYTHON)} ${shellQuote(controllerPath)} > ${shellQuote(consolePath)} 2>&1 < /dev/null & echo $! > ${shellQuote(pidPath)}; }`,
    `echo __CODEX_JOB_SUBMITTED__ ${shellQuote(plan.jobId)}`,
  ].join(" && ");
}

export function globToRegExp(glob) {
  validateBundleGlob(glob);
  const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
}

export function classifyTerminalSnapshot(snapshot) {
  const lines = String(snapshot).split(/\r?\n/u);
  const relevant = lines.filter((line) =>
    /H\d+|image=|source=|rows=|progress|PIPELINE_COMPLETE|"status"|"run_root"|"bundle"|Traceback|Error|FAILED|PASS|__CODEX_/iu.test(
      line,
    ),
  );
  const tail = relevant.slice(-50).join("\n");
  let state = "RUNNING";
  if (/__CODEX_GPU_BUSY__|Traceback|\bFAILED\b|\bError\b/iu.test(tail)) {
    state = "FAILED";
  }
  if (/"status"\s*:\s*"PASS"|PIPELINE_COMPLETE/iu.test(tail)) {
    state = "PASS";
  }
  const runRoot = tail.match(/"run_root"\s*:\s*"([^"]+)"/u)?.[1] ?? null;
  const bundle = tail.match(/"bundle"\s*:\s*"([^"]+\.zip)"/u)?.[1] ?? null;
  return { state, runRoot, bundle, tail };
}

function parseSnapshotToken(source) {
  const value = source.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return value;
}

export function parseJupyterJsonSnapshot(snapshot, filename = "status.json") {
  const lines = String(snapshot).split(/\r?\n/u);
  const panelIndex = lines.findLastIndex((line) => line.includes(`tabpanel "${filename}"`));
  if (panelIndex < 0) throw new Error(`no ${filename} JSON panel`);
  const panelIndent = lines[panelIndex].search(/\S/u);
  const tokens = [];
  for (const line of lines.slice(panelIndex + 1)) {
    const indent = line.search(/\S/u);
    if (indent >= 0 && indent <= panelIndent) break;
    const match = line.trim().match(/^- generic: (.+)$/u);
    if (match) tokens.push({ indent, value: parseSnapshotToken(match[1]) });
  }
  const fields = tokens.filter((t) => typeof t.value === "string" && t.value.endsWith(":") && t.value !== "root:");
  const fieldIndent = Math.min(...fields.map((t) => t.indent));
  const values = {};
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i], next = tokens[i + 1];
    if (token.indent !== fieldIndent || typeof token.value !== "string" || !token.value.endsWith(":")) continue;
    if (next.indent !== fieldIndent || next.value === "▶" || next.value === "▼") continue;
    const key = token.value.slice(0, -1);
    if (key === "root") continue;
    // Jupyter's JSON viewer renders string quotes as text inside the ARIA quote layer.
    values[key] = typeof next.value === "string" ? parseSnapshotToken(next.value) : next.value;
    i++;
  }
  const state = typeof values.state === "string" ? values.state : null;
  if (!["RUNNING", "PASS", "FAILED", "COMPLETE", "PARTIAL"].includes(state)) {
    throw new Error(`Jupyter JSON view did not expose a state field in ${filename}`);
  }
  const progressKeys = [
    "completed",
    "total",
    "completed_unique_images",
    "total_unique_images",
    "last_source_index",
  ];
  const progress = Object.fromEntries(
    progressKeys.filter((key) => key in values && values[key] !== null && values[key] !== "null")
      .map((key) => [key, Number(values[key])]).filter(([, value]) => Number.isFinite(value)),
  );
  return {
    state,
    stage: values.stage ?? null,
    runRoot: values.run_root ?? null,
    bundle: values.bundle ?? null,
    error: values.error ?? null,
    progress,
    values,
  };
}

export function recommendNextCheck(previous, current, baseSeconds) {
  validateWaitSeconds(baseSeconds);
  if (current.state !== "RUNNING") return null;
  const updated = Date.parse(current.values.updated_at);
  if (!Number.isFinite(updated)) return null;
  const done = current.progress.completed, total = current.progress.total;
  if (previous && Number.isFinite(done) && Number.isFinite(total)) {
    const elapsed = (updated - Date.parse(previous.updatedAt)) / 1000;
    const delta = done - previous.completed;
    if (elapsed > 0 && delta > 0 && total > done) {
      const eta = (total - done) * elapsed / delta;
      return Math.max(60, Math.min(7200, Math.round(eta * 0.7 / 60) * 60));
    }
  }
  return baseSeconds;
}

export async function chooseDownloadDestination(directory, filename) {
  if (path.basename(filename) !== filename || /[\\/:]/u.test(filename) || !filename.endsWith(".zip")) {
    throw new Error("invalid bundle filename");
  }
  const parsed = path.parse(filename);
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      await stat(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error(`too many same-name downloads for ${filename}`);
}

export async function copyDownloadedFile(source, destination) {
  if (path.resolve(source) !== path.resolve(destination)) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
  return await inspectZip(destination, "result");
}

export function makeJobId(experimentDirectory) {
  const experiment = experimentDirectory.match(/(?:^|_)h(\d+)(?:_|$)/iu)?.[1];
  const prefix = experiment ? `h${experiment}` : "experiment";
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

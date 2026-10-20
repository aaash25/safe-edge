// Offline preparation/recovery. No browser or server connection is opened here.
import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SafeEdgeBackend } from "./safe_edge_bridge_mcp.mjs";
import { buildRemoteLaunchCommand, canCollectResult, chooseDownloadDestination, copyDownloadedFile, globToRegExp,
  JUPYTER_REPO_PATH, parseJupyterJsonSnapshot, SERVER_REPO, validateDownloadDirectory } from "./jupyter_experiment_helpers.mjs";

const [action, argument, inputPath] = process.argv.slice(2);
const backend = new SafeEdgeBackend();
if (action === "plan" || action === "prepare") {
  if (!argument) throw new Error("usage: node experiment_cli.mjs plan|prepare <config.json>");
  const config = JSON.parse(await readFile(path.resolve(argument), "utf8"));
  const job = await backend.buildJupyterExperimentPlan(config, action === "prepare");
  if (action === "prepare") {
    const duplicate = await backend.registerExperimentJob(job);
    if (duplicate) { console.log(JSON.stringify(duplicate, null, 2)); process.exit(0); }
    job.state = "PREPARED";
    await backend.saveExperimentJob(job);
    // A prepared notebook is a transport fallback, not an automatic restart/resume.
    const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{
      cell_type: "code", execution_count: null, metadata: {}, outputs: [],
      source: ["import subprocess\n", `subprocess.run(["bash", "-lc", ${JSON.stringify(job.launchCommand)}], check=True)\n`],
    }] };
    const notebookPath = path.join(path.dirname(path.resolve(argument)), `${job.jobId}.ipynb`);
    await writeFile(notebookPath, JSON.stringify(notebook, null, 2), { encoding: "utf8", flag: "wx" });
    job.notebookPath = notebookPath;
    await backend.saveExperimentJob(job);
  }
  const { launchCommand, jupyterBaseUrl, ...publicPlan } = job;
  console.log(JSON.stringify(publicPlan, null, 2));
} else if (action === "observe") {
  const job = await backend.loadExperimentJob(argument);
  const snapshot = await readFile(path.resolve(inputPath), "utf8");
  console.log(JSON.stringify(await backend.recordExperimentStatus(job, parseJupyterJsonSnapshot(snapshot)), null, 2));
} else if (action === "collect") {
  const job = await backend.loadExperimentJob(argument);
  if (!canCollectResult(job)) throw new Error("collect requires an exact validated terminal bundle");
  const name = path.posix.basename(job.bundle);
  if (!globToRegExp(job.bundleGlob).test(name)) throw new Error("bundle pattern mismatch");
  await validateDownloadDirectory(job.downloadDirectory, path.resolve(process.env.SAFE_EDGE_WORKSPACE_ROOT || path.dirname(fileURLToPath(import.meta.url))));
  const downloaded = path.resolve(inputPath);
  const destination = path.dirname(downloaded) === path.resolve(job.downloadDirectory)
    ? downloaded : await chooseDownloadDestination(job.downloadDirectory, name);
  const integrity = await copyDownloadedFile(downloaded, destination);
  if (job.bundleBytes && job.bundleBytes !== integrity.bytes) throw new Error("downloaded bundle byte count differs from server");
  Object.assign(job, {localBundle: destination, localBundleMembers: integrity.members,
    localBundleCrcOk: integrity.crc_ok, downloadedAt: new Date().toISOString()});
  await backend.saveExperimentJob(job);
  console.log(JSON.stringify({state:job.state, runRoot:job.runRoot, localBundle:destination, ...integrity}, null, 2));
} else if (action === "command") {
  const job = await backend.loadExperimentJob(argument);
  if (!["PREPARED", "PREPARING"].includes(job.state)) throw new Error("submission is already possible/recorded; check status instead of resubmitting");
  job.remoteJobDirectory = `${SERVER_REPO}/codex_experiment_jobs/${job.jobId}`;
  job.remoteStatusFile = `${job.remoteJobDirectory}/status.json`;
  job.statusJupyterPath = `${JUPYTER_REPO_PATH}/codex_experiment_jobs/${job.jobId}/status.json`;
  job.launchCommand = buildRemoteLaunchCommand(job);
  job.state = "SUBMITTING";
  job.startedAt = new Date().toISOString();
  await backend.saveExperimentJob(job);
  console.log(job.launchCommand);
} else if (action === "jobs") {
  const root = path.join(os.tmpdir(), "safe-edge-experiment-jobs");
  const names = await readdir(root).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  const jobs = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !n.endsWith(".intent.json"))) {
    const job = JSON.parse(await readFile(path.join(root, name), "utf8"));
    jobs.push({ jobId: job.jobId, state: job.state, experiment: job.experimentDirectory,
      localBundle: job.localBundle ?? null, createdAt: job.createdAt });
  }
  console.log(JSON.stringify(jobs, null, 2));
} else {
  throw new Error("usage: node experiment_cli.mjs plan|prepare <config.json> OR command <jobId> OR jobs");
}

import { spawnSync } from "node:child_process";

const python = process.env.PYTHON || "python";
const commands = [
  [python, ["fixtures/generate.py"]],
  [python, ["-m", "unittest", "test_experiment_controller", "test_h219_controller"]],
  ...["helpers", "bridge", "start_failures"].map(name =>
    [process.execPath, [`test_jupyter_experiment_${name}.mjs`]]),
  [process.execPath, ["test_h219_protocol.mjs"]],
  [process.execPath, ["test_safe_edge_host_runtime.mjs"]],
  [process.execPath, ["--test", "test_connection_recovery.mjs"]],
];
for (const [executable, args] of commands) {
  const result = spawnSync(executable, args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

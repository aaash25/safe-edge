"""Offline behavioral checks for the server controller (no browser/server/GPU access).

Run with: python tools/browser_policy_probe/test_experiment_controller.py -v
Only Linux-specific unzip, GPU discovery, and flock are replaced. Launcher tests
use a real, short-lived Python subprocess and real ZIP/status/progress files.
"""

import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import warnings
import zipfile


MODULE_PATH = Path(__file__).with_name("experiment_controller.py")
SPEC = importlib.util.spec_from_file_location("experiment_controller_under_test", MODULE_PATH)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)
REAL_POPEN = subprocess.Popen
REAL_SLEEP = time.sleep


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="controller-behavior-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "authorized"
        self.repo = self.root / "model_lightweighting"
        self.experiment = self.repo / "route" / "hypotheses" / "v999_h999_fixture"
        self.experiment.mkdir(parents=True)
        self.job = self.repo / ".codex_experiment_jobs" / "h999-fixture"
        self.source = self.repo / "H999_source.zip"
        self.entrypoint = self.experiment / "launch_h999.py"
        self.marker = self.experiment / "launcher_started.txt"
        self.member = self.entrypoint.relative_to(self.repo).as_posix()
        self.config = {
            "job_id": "h999-fixture",
            "allowed_root": str(self.root),
            "repository": str(self.repo),
            "python": sys.executable,
            "source": str(self.source),
            "source_bytes": 0,
            "experiment": str(self.experiment),
            "entrypoint": self.entrypoint.name,
            "job_root": str(self.job),
            "hf_endpoint": "https://hf-mirror.com",
            "bundle_glob": "H999_*_bundle.zip",
        }
        self.commands = []
        self.gpu_pids = ""
        self.last_stderr = ""
        self.last_popen = None

    def make_source(self, source_text=None, extra_members=()):
        if source_text is None:
            source_text = self.launcher_source()
        with zipfile.ZipFile(self.source, "w", zipfile.ZIP_STORED) as archive:
            archive.writestr(self.member, source_text.encode("utf-8"))
            for name, data in extra_members:
                archive.writestr(name, data)
        self.config["source_bytes"] = self.source.stat().st_size
        controller.configure(dict(self.config))
        return source_text

    def launcher_source(self, mode="pass", report_changes=None):
        """Keep the launcher realistic: real files, final JSON, and an exit status."""
        return f'''import json
import os
from pathlib import Path
import sys
import zipfile

base = Path.cwd()
(base / "launcher_started.txt").write_text("started", encoding="utf-8")
run_root = base / "run_current"
run_root.mkdir(exist_ok=True)
(run_root / "progress.json").write_text(json.dumps({{"completed": 3, "total": 3, "last_source_index": 47}}), encoding="utf-8")
env_keys = ["TMPDIR", "TMP", "TEMP", "HF_HOME", "XDG_CACHE_HOME", "TORCH_HOME", "PIP_CACHE_DIR", "TRITON_CACHE_DIR", "CUDA_CACHE_PATH", "HF_ENDPOINT"]
(run_root / "environment.json").write_text(json.dumps({{k: os.environ.get(k) for k in env_keys}}), encoding="utf-8")
mode = {mode!r}
if mode == "exit_error":
    print("intentional launcher failure", flush=True)
    sys.exit(7)
bundle = base / ("H999_old_bundle.zip" if mode in ("old_bundle", "overwrite_old_bundle") else "H999_current_bundle.zip")
if mode != "old_bundle":
    with zipfile.ZipFile(bundle, "w") as archive:
        archive.writestr("result.json", json.dumps({{"sample_count": 3}}))
if mode == "no_report":
    print("created result files but no final audited report", flush=True)
    sys.exit(0)
report = {{"status": "PASS", "audit_ok": mode != "audit_false", "run_root": str(run_root), "bundle": str(bundle)}}
report.update({report_changes or {}!r})
print("launcher diagnostic: {{not-json}}", flush=True)
print(json.dumps(report), flush=True)
'''

    def fake_native_run(self, args, **kwargs):
        args = [str(value) for value in args]
        self.commands.append(args)
        if args[:2] == ["unzip", "-n"]:
            self.assertEqual(Path(kwargs["cwd"]), self.repo)
            self.assertTrue(kwargs["check"])
            # source_preflight has already validated every path before this call.
            with zipfile.ZipFile(args[2]) as archive:
                for info in archive.infolist():
                    target = self.repo / info.filename
                    if info.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                    elif not target.exists():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(archive.read(info))
            return subprocess.CompletedProcess(args, 0)
        if args == ["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"]:
            return subprocess.CompletedProcess(args, 0, stdout=self.gpu_pids, stderr="")
        self.fail(f"unexpected external command during offline test: {args!r}")

    def invoke(self):
        stderr = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(controller.subprocess, "run", side_effect=self.fake_native_run))
            stack.enter_context(mock.patch.object(controller, "acquire_lock", return_value=contextlib.nullcontext()))
            stack.enter_context(mock.patch.object(controller.time, "sleep", side_effect=lambda _: REAL_SLEEP(0.01)))
            self.last_popen = stack.enter_context(mock.patch.object(controller.subprocess, "Popen", wraps=REAL_POPEN))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            rc = controller.run()
        self.last_stderr = stderr.getvalue()
        return rc

    def status(self):
        return json.loads((self.job / "status.json").read_text(encoding="utf-8"))

    def assert_failed(self, error_fragment):
        self.assertEqual(self.invoke(), 1)
        status = self.status()
        self.assertEqual(status["state"], "FAILED")
        self.assertEqual(status["stage"], "failed")
        self.assertIn(error_fragment, status["error"])
        return status

    def make_old_bundle(self):
        old = self.experiment / "H999_old_bundle.zip"
        with zipfile.ZipFile(old, "w") as archive:
            archive.writestr("old.txt", "not this run")
        return old

    def make_progress(self, directory, value):
        target = self.experiment / directory / "progress.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value), encoding="utf-8")
        return target

    def test_success_uses_real_launcher_and_exact_audited_new_result(self):
        self.make_progress("run_previous", {"completed": 999, "total": 999})
        self.make_source()
        transitions = []
        original = controller.write_status

        def capture(state, stage, **details):
            original(state, stage, **details)
            transitions.append((state, stage, dict(details)))

        with mock.patch.object(controller, "write_status", side_effect=capture):
            self.assertEqual(self.invoke(), 0, self.last_stderr)
        self.last_popen.assert_called_once()
        self.assertTrue(self.marker.is_file())
        status = self.status()
        self.assertEqual(status["state"], "PASS")
        self.assertEqual(status["stage"], "complete")
        self.assertIs(status["audit_ok"], True)
        self.assertEqual(status["run_root"], str((self.experiment / "run_current").resolve()))
        self.assertEqual(status["bundle"], str((self.experiment / "H999_current_bundle.zip").resolve()))
        self.assertEqual((status["completed"], status["total"]), (3, 3))
        self.assertEqual(status["last_source_index"], 47)
        self.assertGreater(status["bundle_bytes"], 0)
        with zipfile.ZipFile(status["bundle"]) as archive:
            self.assertIsNone(archive.testzip())
        self.assertEqual(transitions[0][:2], ("RUNNING", "preflight"))
        self.assertEqual(transitions[-1][:2], ("PASS", "complete"))
        self.assertNotIn(999, [details.get("completed") for _, _, details in transitions])
        env = json.loads((self.experiment / "run_current" / "environment.json").read_text(encoding="utf-8"))
        self.assertEqual(env.pop("HF_ENDPOINT"), "https://hf-mirror.com")
        for key, value in env.items():
            self.assertTrue(Path(value).resolve().is_relative_to(self.root.resolve()), key)
            self.assertTrue(Path(value).is_dir(), key)

    def test_nonzero_launcher_exit_is_failed_and_retains_log(self):
        self.make_source(self.launcher_source("exit_error"))
        self.assert_failed("exit code 7")
        self.last_popen.assert_called_once()
        self.assertIn("intentional launcher failure", controller.LOG.read_text(encoding="utf-8"))

    def test_zero_exit_and_bundle_without_final_report_is_not_pass(self):
        self.make_source(self.launcher_source("no_report"))
        self.assert_failed("final PASS with audit_ok=true")
        self.assertTrue((self.experiment / "H999_current_bundle.zip").is_file())

    def test_final_audit_false_is_not_pass(self):
        self.make_source(self.launcher_source("audit_false"))
        self.assert_failed("final PASS with audit_ok=true")

    def test_final_failed_status_overrides_earlier_pass_report(self):
        source = self.launcher_source() + 'print(json.dumps({"status": "FAIL", "audit_ok": True}), flush=True)\n'
        self.make_source(source)
        self.assert_failed("final PASS with audit_ok=true")

    def test_preexisting_bundle_cannot_be_reported_as_current_success(self):
        old = self.make_old_bundle()
        before = old.read_bytes()
        self.make_source(self.launcher_source("old_bundle"))
        self.assert_failed("completed bundle already exists; automatic rerun refused")
        self.assertEqual(old.read_bytes(), before)
        self.last_popen.assert_not_called()
        self.assertFalse(self.marker.exists())

    def test_overwriting_old_bundle_does_not_make_it_a_new_result(self):
        self.make_source()
        old = self.make_old_bundle()
        before = {str(old.resolve())}
        with zipfile.ZipFile(old, "w") as archive:
            archive.writestr("new.txt", "overwriting is not a new filename")
        run_root = self.experiment / "run_current"
        run_root.mkdir()
        report = {"status": "PASS", "audit_ok": True, "bundle": str(old), "run_root": str(run_root)}
        with self.assertRaisesRegex(RuntimeError, "pre-existing bundle"):
            controller.final_result(json.dumps(report), before)

    def test_final_report_requires_exact_paths(self):
        self.make_source(self.launcher_source(report_changes={"run_root": None}))
        self.assert_failed("lacks exact bundle/run_root paths")

    def test_final_report_path_escape_is_not_pass(self):
        outside = self.root / "outside_experiment.zip"
        outside.write_bytes(b"outside")
        self.make_source(self.launcher_source(report_changes={"bundle": str(outside)}))
        self.assert_failed("path escaped authorized root")
        self.assertEqual(outside.read_bytes(), b"outside")

    def test_final_report_wrong_glob_is_not_pass(self):
        wrong = self.experiment / "wrong.zip"
        wrong.write_bytes(b"wrong")
        self.make_source(self.launcher_source(report_changes={"bundle": str(wrong)}))
        self.assert_failed("does not match the configured filename pattern")

    def test_final_report_nonexistent_bundle_is_not_pass(self):
        missing = self.experiment / "H999_missing_bundle.zip"
        self.make_source(self.launcher_source(report_changes={"bundle": str(missing)}))
        self.assert_failed("result paths do not exist")

    def test_equal_length_existing_source_crc_conflict_blocks_launch(self):
        source = self.make_source()
        original = source.encode("utf-8")
        different = b"#" + original[1:]
        self.assertEqual(len(different), len(original))
        self.entrypoint.write_bytes(different)
        self.assert_failed("existing source differs; refusing overwrite")
        self.assertEqual(self.entrypoint.read_bytes(), different)
        self.assertFalse(self.marker.exists())
        self.last_popen.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_identical_existing_source_is_reusable(self):
        source = self.make_source()
        self.entrypoint.write_text(source, encoding="utf-8", newline="")
        self.assertEqual(self.invoke(), 0, self.last_stderr)
        self.assertEqual(self.status()["state"], "PASS")
        self.last_popen.assert_called_once()

    def test_wrong_upload_byte_count_fails_before_unpack_or_launch(self):
        self.make_source()
        controller.C["source_bytes"] += 1
        self.assert_failed("uploaded ZIP size mismatch")
        self.assertEqual(self.commands, [])
        self.last_popen.assert_not_called()

    def test_busy_gpu_never_launches_or_terminates_any_process(self):
        self.make_source()
        self.gpu_pids = "154052\n"
        self.assert_failed("GPU busy; processes left untouched: 154052")
        self.assertFalse(self.marker.exists())
        self.last_popen.assert_not_called()
        self.assertEqual([command[0] for command in self.commands], ["unzip", "nvidia-smi"])

    def test_lock_contention_does_not_launch_or_query_gpu(self):
        self.make_source()
        # invoke() replaces flock; exercise the real main path with a contention substitute.
        with mock.patch.object(controller, "acquire_lock", side_effect=RuntimeError("another controller is already running this experiment")), \
             mock.patch.object(controller.subprocess, "run", side_effect=self.fake_native_run), \
             mock.patch.object(controller.subprocess, "Popen", wraps=REAL_POPEN) as popen, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(controller.run(), 1)
        self.assertIn("already running", self.status()["error"])
        popen.assert_not_called()
        self.assertEqual([command[0] for command in self.commands], ["unzip"])

    def test_completed_bundle_is_rechecked_after_acquiring_experiment_lock(self):
        self.make_source()

        @contextlib.contextmanager
        def lock_with_prior_job_finishing():
            self.make_old_bundle()
            yield

        with mock.patch.object(controller, "acquire_lock", side_effect=lock_with_prior_job_finishing), \
             mock.patch.object(controller.subprocess, "run", side_effect=self.fake_native_run), \
             mock.patch.object(controller.subprocess, "Popen", wraps=REAL_POPEN) as popen, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(controller.run(), 1)
        self.assertIn("completed bundle already exists", self.status()["error"])
        popen.assert_not_called()
        self.assertEqual([command[0] for command in self.commands], ["unzip"])

    def test_zip_traversal_is_rejected_before_unpack(self):
        self.make_source(extra_members=(("../escaped.txt", b"no"),))
        self.assert_failed("unsafe ZIP member")
        self.assertEqual(self.commands, [])
        self.assertFalse((self.root / "escaped.txt").exists())
        self.last_popen.assert_not_called()

    def test_zip_file_outside_experiment_is_rejected_before_unpack(self):
        self.make_source(extra_members=(("route/hypotheses/other_experiment/file.txt", b"no"),))
        self.assert_failed("path escaped authorized root")
        self.assertEqual(self.commands, [])
        self.assertFalse((self.repo / "route/hypotheses/other_experiment").exists())

    def test_zip_symlink_member_is_rejected(self):
        member = zipfile.ZipInfo(self.experiment.relative_to(self.repo).as_posix() + "/link")
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.make_source(extra_members=((member, b"../../escape"),))
        self.assert_failed("unsafe ZIP member")
        self.assertEqual(self.commands, [])

    def test_duplicate_zip_member_is_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            self.make_source(extra_members=((self.member, b"duplicate"),))
        self.assert_failed("duplicate ZIP member")
        self.assertEqual(self.commands, [])

    def test_job_outside_authorized_root_is_not_created(self):
        self.make_source()
        outside = self.base / "unauthorized_job"
        controller.configure({**self.config, "job_root": str(outside)})
        with self.assertRaisesRegex(RuntimeError, "path escaped authorized root"):
            self.invoke()
        self.assertFalse(outside.exists())
        self.last_popen.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_source_path_outside_authorized_root_is_not_read(self):
        self.make_source()
        outside = self.base / "unauthorized_source.zip"
        outside.write_bytes(b"must not inspect this as ZIP")
        controller.configure({**self.config, "source": str(outside)})
        self.assert_failed("path escaped authorized root")
        self.assertEqual(outside.read_bytes(), b"must not inspect this as ZIP")
        self.assertEqual(self.commands, [])

    def test_duplicate_invocation_preserves_every_existing_status(self):
        self.make_source()
        self.job.mkdir(parents=True)
        status_path = self.job / "status.json"
        for state in ("RUNNING", "PASS", "FAILED"):
            with self.subTest(state=state):
                original = json.dumps({"state": state, "evidence": "do not change"}).encode("utf-8")
                status_path.write_bytes(original)
                before = status_path.stat().st_mtime_ns
                self.assertEqual(self.invoke(), 1)
                self.assertEqual(status_path.read_bytes(), original)
                self.assertEqual(status_path.stat().st_mtime_ns, before)
                self.last_popen.assert_not_called()
        self.assertEqual(self.commands, [])
        self.assertFalse(self.marker.exists())

    def test_duplicate_after_actual_success_preserves_status_and_bundle(self):
        self.make_source()
        self.assertEqual(self.invoke(), 0, self.last_stderr)
        status_path = self.job / "status.json"
        original = status_path.read_bytes()
        bundle_path = Path(self.status()["bundle"])
        bundle_original = bundle_path.read_bytes()
        command_count = len(self.commands)
        self.assertEqual(self.invoke(), 1)
        self.assertEqual(status_path.read_bytes(), original)
        self.assertEqual(bundle_path.read_bytes(), bundle_original)
        self.assertEqual(len(self.commands), command_count)
        self.last_popen.assert_not_called()

    def test_duplicate_arriving_between_status_checks_preserves_active_job(self):
        self.make_source()
        status_path = self.job / "status.json"
        original = json.dumps({"state": "RUNNING", "pid": 154052, "evidence": "other invocation"}).encode("utf-8")
        real_inside = controller.inside

        def concurrent_invocation_wins(candidate, parent=None):
            # Another invocation creates its status after run()'s initial exists()
            # check, but before the post-claim duplicate check.
            if Path(candidate) == self.job / "execution.claim":
                status_path.write_bytes(original)
            return real_inside(candidate, parent)

        with mock.patch.object(controller, "inside", side_effect=concurrent_invocation_wins):
            self.assertEqual(self.invoke(), 1)
        self.assertEqual(status_path.read_bytes(), original)
        self.last_popen.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_atomic_claim_allows_only_one_of_two_overlapping_invocations(self):
        self.make_source()
        self.job.mkdir(parents=True)
        entered = threading.Event()
        release = threading.Event()
        count_lock = threading.Lock()
        call_count = 0

        def overlapping_main():
            nonlocal call_count
            with count_lock:
                call_count += 1
                index = call_count
            if index == 1:
                entered.set()
                if not release.wait(timeout=3):
                    raise RuntimeError("test did not release the first invocation")

        with mock.patch.object(controller, "main", side_effect=overlapping_main), \
             contextlib.redirect_stderr(io.StringIO()), \
             ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(controller.run)
            self.assertTrue(entered.wait(timeout=2))
            second = pool.submit(controller.run)
            try:
                second_result = second.result(timeout=2)
            finally:
                release.set()
            first_result = first.result(timeout=2)
        self.assertEqual(first_result, 0)
        self.assertEqual(second_result, 1)
        self.assertEqual(call_count, 1)

    def test_existing_execution_claim_without_status_never_restarts_job(self):
        self.make_source()
        self.job.mkdir(parents=True)
        claim = self.job / "execution.claim"
        claim.write_text("previous controller may have submitted before disconnect", encoding="utf-8")
        before = claim.read_bytes()
        self.assertEqual(self.invoke(), 1)
        self.assertFalse((self.job / "status.json").exists())
        self.assertEqual(claim.read_bytes(), before)
        self.last_popen.assert_not_called()
        self.assertEqual(self.commands, [])

    def test_unchanged_previous_progress_is_not_current_progress(self):
        self.make_source()
        self.make_progress("run_old", {"completed": 268, "total": 268})
        before = controller.progress_snapshot()
        self.assertEqual(controller.read_progress(before), {})

    def test_new_progress_uses_unique_image_fields_and_current_run_root(self):
        self.make_source()
        self.make_progress("run_old", {"completed": 268, "total": 268})
        before = controller.progress_snapshot()
        current = self.make_progress("run_new", {"completed_unique_images": 5, "total_unique_images": 25})
        result = controller.read_progress(before)
        self.assertEqual((result["completed"], result["total"]), (5, 25))
        self.assertEqual(result["run_root"], str(current.parent.resolve()))

    def test_modified_existing_progress_counts_as_current_activity(self):
        self.make_source()
        current = self.make_progress("run_resumed", {"completed": 1, "total": 25})
        before = controller.progress_snapshot()
        previous_stamp = current.stat().st_mtime_ns
        current.write_text(json.dumps({"completed": 2, "total": 25}), encoding="utf-8")
        os.utime(current, ns=(previous_stamp + 1_000_000_000, previous_stamp + 1_000_000_000))
        result = controller.read_progress(before)
        self.assertEqual((result["completed"], result["total"]), (2, 25))
        self.assertEqual(result["run_root"], str(current.parent.resolve()))

    def test_partial_progress_json_is_ignored_without_reporting_stale_run(self):
        self.make_source()
        self.make_progress("run_old", {"completed": 268, "total": 268})
        before = controller.progress_snapshot()
        partial = self.experiment / "run_partial" / "progress.json"
        partial.parent.mkdir()
        partial.write_text('{"completed":', encoding="utf-8")
        self.assertEqual(controller.read_progress(before), {})


if __name__ == "__main__":
    unittest.main()

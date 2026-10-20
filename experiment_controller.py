"""Small server-side job controller. Config is prepended by the safe bridge.

No model logic lives here: the experiment's launcher owns contract/smoke/audit/ZIP.
The only polling here is a cheap file heartbeat, not an agent/browser request.
"""
import fnmatch
import json
import os
import stat
import subprocess
import time
import traceback
import zipfile
import zlib
from pathlib import Path, PurePosixPath


def configure(config):
    global C, ROOT, REPO, PYTHON, SOURCE, EXPERIMENT, ENTRYPOINT, JOB, STATUS, LOG
    C = config
    ROOT = Path(C["allowed_root"])
    REPO = Path(C["repository"])
    # Venv Python may be a symlink to the system interpreter; its working files stay in ROOT.
    PYTHON = Path(C["python"])
    SOURCE = Path(C["source"])
    EXPERIMENT = Path(C["experiment"])
    ENTRYPOINT = EXPERIMENT / C["entrypoint"]
    JOB = Path(C["job_root"])
    STATUS, LOG = JOB / "status.json", JOB / "run.log"


def inside(candidate, parent=None):
    root = Path(parent or ROOT).resolve()
    resolved = Path(candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise RuntimeError(f"path escaped authorized root: {candidate}")
    return resolved


def write_status(state, stage, **details):
    inside(JOB)
    payload = {"job_id": C["job_id"], "state": state, "stage": stage,
               "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **details}
    temporary = inside(STATUS.with_name(f".status.tmp.{os.getpid()}"))
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, STATUS)


def log_tail(max_bytes=65536):
    if not LOG.is_file():
        return ""
    with LOG.open("rb") as handle:
        handle.seek(max(0, LOG.stat().st_size - max_bytes))
        return handle.read(max_bytes).decode("utf-8", errors="replace")


def signature(file):
    info = file.stat()
    return info.st_size, info.st_mtime_ns


def is_h219():
    requested = C.get("result_protocol") == "h219_precision_v1"
    if requested and (EXPERIMENT.name != "v527_h219_smolvlm_mlpq_precision_pope300_hr800"
                      or ENTRYPOINT.name != "launch_h219.py"):
        raise RuntimeError("H219 protocol is restricted to its exact experiment and entrypoint")
    return requested


def progress_snapshot():
    return {str(p): signature(p) for p in EXPERIMENT.glob("*/progress.json") if p.is_file()}


def read_progress(before):
    candidates = sorted(EXPERIMENT.glob("*/progress.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    for file in candidates:
        try:
            inside(file, EXPERIMENT)
            if before.get(str(file)) == signature(file):
                continue  # Do not present an unchanged previous run as current progress.
            value = json.loads(file.read_text(encoding="utf-8"))
            return {"run_root": str(file.parent.resolve()),
                    "completed": value.get("completed", value.get("completed_unique_images", value.get("completed_images"))),
                    "total": value.get("total", value.get("total_unique_images", value.get("total_images"))),
                    "last_source_index": value.get("last_source_index")}
        except (OSError, ValueError):
            continue
    return {}


def source_preflight():
    for candidate in (REPO, SOURCE, EXPERIMENT, ENTRYPOINT, JOB):
        inside(candidate)
    if SOURCE.stat().st_size != C["source_bytes"]:
        raise RuntimeError("uploaded ZIP size mismatch")
    with zipfile.ZipFile(SOURCE) as archive:
        infos = archive.infolist()
        if len({i.filename for i in infos}) != len(infos):
            raise RuntimeError("duplicate ZIP member")
        for info in infos:
            part = PurePosixPath(info.filename)
            if part.is_absolute() or ".." in part.parts or "\\" in info.filename or ":" in info.filename or stat.S_ISLNK(info.external_attr >> 16):
                raise RuntimeError(f"unsafe ZIP member: {info.filename}")
            target = inside(REPO / info.filename)
            if not info.is_dir():
                inside(target, EXPERIMENT)
            # Only already-present source members need a comparison; no SHA or model scan.
            if target.is_file() and not info.is_dir():
                crc = 0
                with target.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        crc = zlib.crc32(chunk, crc)
                if target.stat().st_size != info.file_size or (crc & 0xFFFFFFFF) != info.CRC:
                    raise RuntimeError(f"existing source differs; refusing overwrite: {target}")
    subprocess.run(["unzip", "-n", str(SOURCE)], cwd=REPO, check=True)
    if not ENTRYPOINT.is_file():
        raise FileNotFoundError(ENTRYPOINT)


def gpu_preflight():
    result = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"],
                            capture_output=True, text=True, check=True)
    if result.stdout.strip():
        raise RuntimeError(f"GPU busy; processes left untouched: {result.stdout.strip()}")


def acquire_lock():
    import fcntl  # Linux server only. Released by the OS on exit/reset; never kills a process.
    handle = inside(EXPERIMENT / ".codex-controller.lock").open("a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise RuntimeError("another controller is already running this experiment")
    return handle


def final_reports(text):
    decoder, results = json.JSONDecoder(), []
    offset = 0
    while offset < len(text):
        start = text.find("{", offset)
        if start < 0:
            break
        try:
            value, consumed = decoder.raw_decode(text[start:])
            if isinstance(value, dict) and "status" in value:
                results.append(value)
            offset = start + consumed
        except ValueError:
            offset = start + 1
    return results


def final_result(text, before_bundles):
    results = final_reports(text)
    if not results or results[-1].get("status") != "PASS" or results[-1].get("audit_ok") is not True:
        raise RuntimeError("launcher did not report final PASS with audit_ok=true")
    result = results[-1]
    if not isinstance(result.get("bundle"), str) or not isinstance(result.get("run_root"), str):
        raise RuntimeError("launcher final report lacks exact bundle/run_root paths")
    bundle = inside(result["bundle"], EXPERIMENT)
    run_root = inside(result["run_root"], EXPERIMENT)
    if bundle.parent != EXPERIMENT.resolve() or not fnmatch.fnmatchcase(bundle.name, C["bundle_glob"]):
        raise RuntimeError("launcher bundle does not match the configured filename pattern")
    if str(bundle) in before_bundles:
        raise RuntimeError("launcher reported a pre-existing bundle")
    if not bundle.is_file() or bundle.stat().st_size == 0 or not run_root.is_dir():
        raise RuntimeError("launcher result paths do not exist")
    return {"run_root": str(run_root), "bundle": str(bundle), "audit_ok": True,
            "bundle_bytes": bundle.stat().st_size}


def final_h219(text, before_bundles, before_summary, rc):
    """Normalize the unmodified H219 launcher, without inventing an audit PASS."""
    reports = final_reports(text)
    if not reports or not isinstance(reports[-1].get("bundle"), str):
        raise RuntimeError(f"H219 launcher lacks final artifact report (exit {rc}): {text[-4000:]}")
    report = reports[-1]
    bundle = inside(report["bundle"], EXPERIMENT)
    run_root = inside(EXPERIMENT / "run_precision", EXPERIMENT)
    if bundle.parent != EXPERIMENT.resolve() or not fnmatch.fnmatchcase(bundle.name, C["bundle_glob"]):
        raise RuntimeError("H219 bundle filename/path mismatch")
    if str(bundle) in before_bundles or not bundle.is_file() or bundle.stat().st_size == 0:
        raise RuntimeError("H219 result bundle is old or missing")
    result = {"state": "FAILED", "result_protocol": "h219_precision_v1",
              "run_root": str(run_root), "bundle": str(bundle), "bundle_bytes": bundle.stat().st_size,
              "artifact_ready": True, "launcher_returncode": rc,
              "launcher_status": report.get("status"), "summary_validated": False}
    try:
        summary_path = inside(run_root / "summary.json", EXPERIMENT)
        if not summary_path.is_file() or signature(summary_path) == before_summary:
            raise RuntimeError("H219 summary missing or unchanged from before this launch")
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        count = summary.get("committed_units")
        if (summary.get("version") != "h219-r1-mlpq-precision-single-pass" or
                type(count) is not int or not 0 <= count <= 4400 or
                summary.get("expected_units") != 4400 or summary.get("missing_units") != 4400 - count or
                summary.get("complete") is not (count == 4400) or
                report.get("committed_units") != count or report.get("expected_units") != 4400):
            raise RuntimeError("H219 final report/summary counts or contract mismatch")
        result.update(completed=count, total=4400, missing_units=4400-count, summary_validated=True)
        reported_rc = report.get("returncode")
        if type(reported_rc) is not int or (reported_rc != rc and not (
                reported_rc == 0 and rc == 1 and count < 4400 and report.get("status") == "partial_or_failed")):
            raise RuntimeError("H219 reported and actual exit codes disagree")
        if rc == 0 and report.get("status") == "complete" and count == 4400:
            result["state"] = "COMPLETE"
        elif report.get("status") == "partial_or_failed" and count < 4400:
            result["state"] = "PARTIAL"
            result["error"] = ("seven-hour launcher budget exhausted; no automatic extension" if rc == 75 else
                               f"launcher ended before all units were committed (exit {rc}): {text[-4000:]}")
        else:
            raise RuntimeError(f"H219 launcher did not complete successfully (exit {rc}): {text[-4000:]}")
    except (OSError, ValueError, RuntimeError) as error:
        result["error"] = str(error)
    return result


def main():
    inside(JOB).mkdir(parents=True, exist_ok=True)
    if STATUS.exists():
        raise RuntimeError("this job already has a status; do not submit it again")
    write_status("RUNNING", "preflight")
    source_preflight()
    with acquire_lock():
        before_bundles = {str(p.resolve()) for p in EXPERIMENT.glob(C["bundle_glob"])}
        if before_bundles:
            raise RuntimeError("completed bundle already exists; automatic rerun refused")
        gpu_preflight()
        before_progress = progress_snapshot()
        h219 = is_h219()
        summary_path = EXPERIMENT / "run_precision" / "summary.json"
        before_summary = signature(summary_path) if h219 and summary_path.is_file() else None
        # Redirect all task-created cache/temp locations into the authorized repository.
        dirs = {"TMPDIR": REPO / ".tmp", "TMP": REPO / ".tmp", "TEMP": REPO / ".tmp",
                "HF_HOME": REPO / ".cache" / "huggingface", "XDG_CACHE_HOME": REPO / ".cache",
                "HF_HUB_CACHE": REPO / ".cache" / "huggingface" / "hub",
                "TRANSFORMERS_CACHE": REPO / ".cache" / "huggingface" / "hub",
                "TORCH_HOME": REPO / ".cache" / "torch", "PIP_CACHE_DIR": REPO / ".cache" / "pip",
                "TRITON_CACHE_DIR": REPO / ".cache" / "triton", "CUDA_CACHE_PATH": REPO / ".cache" / "cuda"}
        for value in dirs.values():
            inside(value).mkdir(parents=True, exist_ok=True)
        env = {**os.environ, **{k: str(v) for k, v in dirs.items()},
               "HF_ENDPOINT": C["hf_endpoint"], "PYTHONUNBUFFERED": "1"}
        write_status("RUNNING", "launch")
        with LOG.open("x", encoding="utf-8", buffering=1) as output:
            argv = ([str(PYTHON), "-u", ENTRYPOINT.name, "--max-hours", "7"] if h219 else
                    [str(PYTHON), ENTRYPOINT.name])
            process = subprocess.Popen(argv, cwd=EXPERIMENT,
                                       env=env, stdout=output, stderr=subprocess.STDOUT, text=True)
            while True:
                rc = process.poll()
                progress = read_progress(before_progress)
                write_status("RUNNING", "launch", pid=process.pid, **progress)
                if rc is not None:
                    break
                time.sleep(30)
        if h219:
            result = final_h219(log_tail(), before_bundles, before_summary, rc)
            state = result.pop("state")
            write_status(state, state.lower(), **result)
            return
        if rc != 0:
            raise RuntimeError(f"launcher failed with exit code {rc}: {log_tail()[-4000:]}")
        # Launcher emits the exact audited result at EOF; an old glob match is not completion.
        result = final_result(log_tail(), before_bundles)
        write_status("PASS", "complete", **{**read_progress(before_progress), **result})


def run():
    # An uncertain submission is recovered by status(), never by re-executing this job.
    if STATUS.exists():
        return 1
    inside(JOB).mkdir(parents=True, exist_ok=True)
    try:
        with inside(JOB / "execution.claim").open("x") as claim:
            claim.write(str(os.getpid()))
    except FileExistsError:
        return 1
    if STATUS.exists():
        return 1
    try:
        main()
    except Exception as error:
        traceback.print_exc()
        # No status rewrite on a duplicate invocation: retain the original job's evidence.
        try:
            if STATUS.exists() and json.loads(STATUS.read_text(encoding="utf-8")).get("state") == "PASS":
                return 1
            inside(JOB).mkdir(parents=True, exist_ok=True)
            write_status("FAILED", "failed", error_type=type(error).__name__, error=str(error))
        except Exception:
            traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    configure(CONFIG)
    raise SystemExit(run())

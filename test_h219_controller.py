"""Offline H219 launcher-protocol checks; no server, network, torch or GPU."""
import json
from pathlib import Path
import unittest

from test_experiment_controller import ControllerTest, controller


class H219ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.f = ControllerTest(methodName="runTest")
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        f.experiment = f.repo / "route/hypotheses/v527_h219_smolvlm_mlpq_precision_pope300_hr800"
        f.experiment.mkdir()
        f.entrypoint = f.experiment / "launch_h219.py"
        f.marker = f.experiment / "launcher_started.txt"
        f.member = f.entrypoint.relative_to(f.repo).as_posix()
        f.config.update(experiment=str(f.experiment), entrypoint=f.entrypoint.name,
                        result_protocol="h219_precision_v1", bundle_glob="H219_*_bundle.zip")

    def source(self, count=4400, rc=0, report_rc=None, status=None, summary_changes=None,
               write_summary=True, report=True):
        report_rc = rc if report_rc is None else report_rc
        status = status or ("complete" if rc == 0 and count == 4400 else "partial_or_failed")
        return f'''import json, sys, zipfile
from pathlib import Path
base=Path.cwd()
run=base/'run_precision'
run.mkdir(exist_ok=True)
(base/'launcher_started.txt').write_text(json.dumps(sys.argv[1:]))
summary=dict(version='h219-r1-mlpq-precision-single-pass', complete={count}==4400,
             committed_units={count}, expected_units=4400, missing_units=4400-{count})
summary.update({summary_changes or {}!r})
if {write_summary!r}:
    (run/'summary.json').write_text(json.dumps(summary))
(run/'progress.json').write_text(json.dumps(dict(completed={count},total=4400)))
bundle=base/'H219_current_bundle.zip'
with zipfile.ZipFile(bundle,'x') as z:
    z.writestr('summary.json',json.dumps(summary))
print('fixture original launcher error' if {rc} else 'fixture completed',flush=True)
if {report!r}:
    print(json.dumps(dict(status={status!r},returncode={report_rc},committed_units={count},
                         expected_units=4400,bundle=str(bundle))),flush=True)
sys.exit({rc})
'''

    def run_source(self, **kwargs):
        self.f.make_source(self.source(**kwargs))
        self.f.invoke()
        return self.f.status()

    def test_complete_and_exact_argv_without_fabricated_audit(self):
        state = self.run_source()
        self.assertEqual(state['state'], 'COMPLETE')
        self.assertEqual((state['completed'],state['total']), (4400,4400))
        self.assertNotIn('audit_ok',state)
        self.assertTrue(state['artifact_ready'])
        self.f.last_popen.assert_called_once()
        self.assertEqual(self.f.last_popen.call_args.args[0][1:], ['-u','launch_h219.py','--max-hours','7'])

    def test_budget_exit_is_partial_and_downloadable(self):
        state = self.run_source(count=731,rc=75)
        self.assertEqual(state['state'],'PARTIAL')
        self.assertEqual(state['missing_units'],3669)
        self.assertTrue(state['artifact_ready'])
        self.assertEqual(state['launcher_returncode'],75)
        self.assertIn('no automatic extension',state['error'])

    def test_original_report_zero_exit_one_partial_boundary(self):
        state = self.run_source(count=0,rc=1,report_rc=0)
        self.assertEqual(state['state'],'PARTIAL')

    def test_entry_error_preserves_original_error_and_partial_archive(self):
        state = self.run_source(count=40,rc=7)
        self.assertEqual(state['state'],'PARTIAL')
        self.assertIn('fixture original launcher error',state['error'])
        self.assertEqual(state['launcher_returncode'],7)

    def test_complete_counts_with_error_are_failed_not_complete(self):
        state = self.run_source(count=4400,rc=7)
        self.assertEqual(state['state'],'FAILED')
        self.assertTrue(state['artifact_ready'])

    def test_false_complete_and_count_mismatch_fail(self):
        state = self.run_source(count=400,status='complete',summary_changes={'complete':True})
        self.assertEqual(state['state'],'FAILED')
        self.assertTrue(state['artifact_ready'])
        self.assertIn('mismatch',state['error'])

    def test_old_summary_not_accepted(self):
        path = self.f.experiment/'run_precision'
        path.mkdir()
        (path/'summary.json').write_text('{}')
        state = self.run_source(write_summary=False)
        self.assertEqual(state['state'],'FAILED')
        self.assertIn('unchanged',state['error'])

    def test_missing_report_keeps_log_and_no_download_flag(self):
        state = self.run_source(count=4,rc=7,report=False)
        self.assertEqual(state['state'],'FAILED')
        self.assertNotIn('artifact_ready',state)
        self.assertIn('fixture original launcher error',state['error'])

    def test_other_exit_mismatch_fails(self):
        state = self.run_source(count=40,rc=7,report_rc=0)
        self.assertEqual(state['state'],'FAILED')
        self.assertIn('exit codes disagree',state['error'])

    def test_preexisting_bundle_never_relaunches(self):
        (self.f.experiment/'H219_old_bundle.zip').write_bytes(b'preserved')
        state = self.run_source()
        self.assertEqual(state['state'],'FAILED')
        self.f.last_popen.assert_not_called()

    def test_terminal_partial_cannot_restart_or_extend_budget(self):
        state = self.run_source(count=731,rc=75)
        previous = (self.f.job/'status.json').read_bytes()
        self.assertEqual(self.f.invoke(),1)
        self.assertEqual((self.f.job/'status.json').read_bytes(),previous)
        self.f.last_popen.assert_not_called()


if __name__ == '__main__':
    unittest.main()

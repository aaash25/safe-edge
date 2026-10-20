import assert from 'node:assert/strict';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { SafeEdgeBackend } from './safe_edge_bridge_mcp.mjs';
import { buildControllerSource, canCollectResult, parseJupyterJsonSnapshot } from './jupyter_experiment_helpers.mjs';

const backend = new SafeEdgeBackend();
const source = path.resolve('fixtures/h219-source.zip');
const plan = await backend.buildJupyterExperimentPlan({jupyterUrl:'http://aic.bnu.edu.cn/jupyter-forward/test/lab',
  sourceZip:source,bundleGlob:'H219_mlpq_precision_pope300_hr800_*_bundle.zip',waitSeconds:1800,
  downloadDirectory:path.resolve('test-downloads')});
assert.equal(plan.resultProtocol,'h219_precision_v1');
assert.match(buildControllerSource(plan),/h219_precision_v1/);
let saved;
backend.saveExperimentJob=async job=>{saved=structuredClone(job);};
const snapshot = fields => '- main:\n  - tabpanel "status.json":\n    - list:\n      - generic: "root:"\n      - list:\n'+Object.entries(fields).map(([k,v])=>`        - generic: ${JSON.stringify(k+':')}\n        - generic: ${JSON.stringify(v)}\n`).join('');
const base={job_id:plan.jobId,updated_at:new Date().toISOString(),result_protocol:'h219_precision_v1',
  artifact_ready:true,summary_validated:true,launcher_returncode:0,
  bundle:plan.remoteExperiment+'/H219_mlpq_precision_pope300_hr800_fixture_bundle.zip',
  run_root:plan.remoteExperiment+'/run_precision',completed:4400,total:4400,missing_units:0,bundle_bytes:(await stat(source)).size};
for(const [state,count,rc] of [['COMPLETE',4400,0],['PARTIAL',91,75],['FAILED',4400,7]]) {
  const parsed=parseJupyterJsonSnapshot(snapshot({...base,state,completed:count,missing_units:4400-count,launcher_returncode:rc}));
  const result=await backend.recordExperimentStatus(structuredClone(plan),parsed);
  assert.equal(result.state,state);
  assert.equal(canCollectResult(saved),true);
  backend.loadExperimentJob=async()=>({...saved,localBundle:source,localBundleCrcOk:true});
  const downloaded=await backend.downloadJupyterExperiment(plan.jobId);
  assert.equal(downloaded.state,state);
}
await assert.rejects(backend.recordExperimentStatus(structuredClone(plan),parseJupyterJsonSnapshot(snapshot({...base,state:'COMPLETE',completed:1,missing_units:4399}))),/counts/);
await assert.rejects(backend.recordExperimentStatus({...plan,resultProtocol:'audited_pass_v1'},parseJupyterJsonSnapshot(snapshot({...base,state:'COMPLETE'}))),/protocol/);
await assert.rejects(backend.recordExperimentStatus(structuredClone(plan),parseJupyterJsonSnapshot(snapshot({...base,state:'PARTIAL',completed:1,missing_units:4399,bundle:'/outside/evil.zip'}))),/paths/);
assert.equal(canCollectResult({...saved,state:'RUNNING'}),false);
assert.equal(canCollectResult({...saved,artifactReady:false}),false);
assert.equal(canCollectResult({...saved,experimentDirectory:'v526_h218_other',state:'PARTIAL'}),false);
console.log(JSON.stringify({passed:true,checks:['fixed protocol','terminal snapshot roundtrip','complete/partial/failed cached download preserve state','counts and paths','no RUNNING download']}));

import '../src/tools/index';
import {registerAllTools} from '../src/tools';
registerAllTools();
import {handleNewRequirement} from '../src/agents/auto-analyzer';
(async()=>{
  console.log('Tools:',require('../src/tools').toolRegistry.list().length);
  const r=await handleNewRequirement('7039179458','ou_test','oc_test');
  console.log('Result:',JSON.stringify(r));
})().catch(e=>console.error('FATAL:',e.message||e));

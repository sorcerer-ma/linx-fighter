import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadSandboxConfig } from '../sandbox/config.js';
import { SandboxAgent, createSandboxAgent } from '../sandbox/platform/agent.js';
const tools={async listTools(){return [{name:'game_status'},{name:'game_say'},{name:'game_action'},{name:'game_start'}]},async callTool(){throw new Error('must not execute')}};
it('配置不选默认模型；提示词单源，未配置明确为兼容；不静默启动伪Agent',()=>{
 const config=loadSandboxConfig({});assert.equal(config.agent.model,undefined);assert.equal(createSandboxAgent(config.agent),undefined);
 assert.throws(()=>createSandboxAgent({...config.agent,model:'test'}),/配置未完成/);
 assert.throws(()=>createSandboxAgent({...config.agent,model:'test',baseUrl:'http://example.invalid',apiKey:'fake'}),/尚未选择/);
 assert.throws(()=>createSandboxAgent({...config.agent,promptPath:'/no-such-agent-prompt'}));
});
it('Agent失败不重试工具、不转game_say，拒绝把理解交回后端',async()=>{
 for(const choice of [{tool:'game_say',arguments:{text:'打'}},{tool:'game_action',arguments:{action:'用力打'}},{tool:'game_start',arguments:{text:'联机'}}]){
  const agent=new SandboxAgent('test',{async select(){return choice}});
  await assert.rejects(agent.run('one','打',tools));
 }
 const agent=new SandboxAgent('test',{async select(){throw new Error('model failed')}});
 await assert.rejects(agent.run('one','打',tools),/model failed/);
});
it('无明确选择时只澄清；工具文本与错误原样返回，不润色战果',async()=>{
 const unclear=new SandboxAgent('test',{async select(){return null}});
 assert.equal((await unclear.run('one','不确定',tools)).tool,'none');
 const agent=new SandboxAgent('test',{async select(){return {tool:'game_status',arguments:{}}}});
 const result=await agent.run('one','状态',{...tools,async callTool(){return {text:'结果待核实，不能确认命中。',isError:true}}});
 assert.equal(result.text,'结果待核实，不能确认命中。');assert.equal(result.isError,true);
});

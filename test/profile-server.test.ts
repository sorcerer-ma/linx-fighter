import assert from 'node:assert/strict';import{it}from'node:test';import type{AddressInfo}from'node:net';
import{createSandboxServer}from'../sandbox/server.js';import{loadSandboxConfig}from'../sandbox/config.js';import type{SandboxClient}from'../sandbox/platform/client.js';
it('页面只提供三profile，say/wait校验后同一profile传至Agent，未知不执行',async()=>{
 const calls:any[]=[];const client={agentMode:'relay',async say(device:string,text:string,options:any){calls.push({tool:'say',profile:options.profileId});return{ok:true,profileId:options.profileId};},async wait(device:string,options:any){calls.push({tool:'wait',profile:options.profileId});return{ok:true,profileId:options.profileId};}}as unknown as SandboxClient;
 const server=createSandboxServer({config:loadSandboxConfig({}),client}).listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));const root=`http://127.0.0.1:${(server.address()as AddressInfo).port}`;
 const post=(path:string,body:object)=>fetch(root+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  const config=await(await fetch(root+'/api/config')).json()as any;assert.deepEqual(config.speechProfiles.map((x:any)=>x.id),['cancan','qingcang','tiancai']);assert.equal(config.defaultSpeechProfile,'cancan');
  for(const profileId of ['cancan','qingcang','tiancai']){
   assert.equal((await post('/api/say',{deviceId:'qa-profile',text:'开始',profileId})).status,200);
   assert.equal((await post('/api/wait',{deviceId:'qa-profile',profileId})).status,200);
  }
  assert.deepEqual(calls.map(x=>x.profile),['cancan','cancan','qingcang','qingcang','tiancai','tiancai']);
  for(const path of ['/api/say','/api/wait'])assert.equal((await post(path,{deviceId:'qa-profile',text:'开始',profileId:'other'})).status,400);assert.equal(calls.length,6);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

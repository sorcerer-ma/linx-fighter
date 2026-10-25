import assert from 'node:assert/strict';
import { it } from 'node:test';
const { createConversation } = await import(new URL('../sandbox/public/conversation.js', import.meta.url).href);
function harness() {
  const frames:Array<()=>void>=[], observers:Array<()=>void>=[];
  const doc:any={defaultView:{requestAnimationFrame(fn:()=>void){frames.push(fn);return frames.length;},ResizeObserver:class{constructor(fn:()=>void){observers.push(fn);}observe(){}}}};
  function element():any{return {ownerDocument:doc,children:[],dataset:{},events:{},hidden:true,append(...items:any[]){this.children.push(...items);},addEventListener(name:string,fn:()=>void){this.events[name]=fn;}};}
  doc.createElement=element;
  const list=element(),viewport=element(),button=element();let top=0,extra=0;
  viewport.clientHeight=120;
  Object.defineProperty(viewport,'scrollHeight',{get(){return list.children.length*40+extra;}});
  Object.defineProperty(viewport,'scrollTop',{get(){return top;},set(value){top=Math.max(0,Math.min(value,viewport.scrollHeight-viewport.clientHeight));}});
  const conversation=createConversation(viewport,list,button);
  const flush=()=>{for(const fn of frames.splice(0))fn();};
  return {conversation,list,viewport,button,flush,resize(){extra+=80;for(const fn of observers)fn();flush();}};
}
it('完整消息按玩家/伙伴/系统顺序保留，文字不被当作HTML',()=>{
 const h=harness();for(let i=0;i<20;i++){h.conversation.append('player','玩家'+i);h.conversation.append('partner','伙伴'+i);}
 h.conversation.append('system','<script>只作文本</script>','warn');h.flush();
 assert.equal(h.list.children.length,41);
 assert.deepEqual(h.list.children.slice(0,2).map((e:any)=>e.children[0].textContent),['玩家','伙伴']);
 assert.equal(h.list.children[40].children[0].textContent,'系统');
 assert.equal(h.list.children[40].children[1].textContent,'<script>只作文本</script>');
 assert.equal(h.viewport.scrollTop,h.viewport.scrollHeight-h.viewport.clientHeight);
});
it('底部跟随连续和异步长消息，上翻历史后不抢位置，回最新后恢复',()=>{
 const h=harness();for(let i=0;i<20;i++)h.conversation.append('partner','消息'+i);h.flush();
 h.resize();assert.equal(h.viewport.scrollTop,h.viewport.scrollHeight-h.viewport.clientHeight);
 h.viewport.scrollTop=40;h.viewport.events.scroll();
 h.conversation.append('player','追加');h.conversation.append('partner','完整长回复'.repeat(30));h.flush();h.resize();
 assert.equal(h.viewport.scrollTop,40);assert.equal(h.button.hidden,false);
 h.button.events.click();h.flush();assert.equal(h.viewport.scrollTop,h.viewport.scrollHeight-h.viewport.clientHeight);
 h.conversation.append('system','状态变化');h.flush();assert.equal(h.button.hidden,true);
 assert.equal(h.viewport.scrollTop,h.viewport.scrollHeight-h.viewport.clientHeight);
});
it('手动滚回底部也恢复自动跟随',()=>{
 const h=harness();for(let i=0;i<12;i++)h.conversation.append('partner','消息');h.flush();
 h.viewport.scrollTop=0;h.viewport.events.scroll();h.viewport.scrollTop=h.viewport.scrollHeight;h.viewport.events.scroll();
 h.conversation.append('player','新消息');h.flush();assert.equal(h.viewport.scrollTop,h.viewport.scrollHeight-h.viewport.clientHeight);
});

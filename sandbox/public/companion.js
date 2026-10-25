/** Presentation only: snapshots and settled history come from the service. */
export function companionView(battle, connected, event = null, listening = false) {
  if (!connected) return { visual: 'offline', ultimate: 'unknown' };
  if (!battle) return { visual: listening ? 'listening' : 'idle', ultimate: 'unknown' };
  const you = battle.you;
  const ultimate = battle.phase !== 'battle' ? 'ended'
    : you.ultLeft <= 0 ? 'used'
    : !battle.waiting && battle.active === 'player' && !battle.pending && you.ap >= 4 ? 'ready'
    : 'insufficient';
  let visual = 'idle';
  if (battle.phase === 'victory') visual = 'victory';
  else if (battle.phase === 'defeat') visual = 'defeat';
  else if (listening) visual = 'listening';
  else if (event) {
    if (event.actor === 'player') visual = 'attacking';
    else if (event.dodged) visual = 'dodgeSuccess';
    else if (event.guarded) visual = 'defending';
    else if (event.damage > 0) visual = 'hurt';
  } else if (battle.pending?.actor === 'player') visual = 'accepted';
  return { visual, ultimate };
}

export function newSettlement(previous, next) {
  // Initial loads, reconnects and replaced games must not replay old actions.
  if (!previous || !next || previous.room !== next.room || next.history.length <= previous.history.length) return null;
  const prefix = next.history.slice(0, previous.history.length);
  if (JSON.stringify(prefix) !== JSON.stringify(previous.history)) return null;
  const entry = next.history.at(-1);
  return entry.action === 'charge' ? null : entry;
}

function refreshFace(app,key){
 const parts=['eyes-open','eyes-happy','eyes-impact','eyes-low','brow-ready','brow-listen','brow-question','mouth-neutral','mouth-listen','mouth-cheer','mouth-shock','mouth-low','mouth-question','question-mark','impact-lines','held-pose'];
 const shown=new Set(['eyes-open','mouth-neutral']);
 if(['listening','accepted','attacking','guardIntent','defending','dodgeIntent'].includes(key)){shown.delete('mouth-neutral');shown.add('mouth-listen');shown.add(key==='listening'?'brow-listen':'brow-ready')}
 if(key==='dodgeSuccess')shown.add('brow-ready');
 if(['guardIntent','defending'].includes(key))shown.add('held-pose');
 if(key==='victory'){shown.delete('eyes-open');shown.delete('mouth-neutral');shown.add('eyes-happy');shown.add('mouth-cheer')}
 if(['hurt','dodgeFailed'].includes(key)&&app.classList.contains('impact-active')){shown.delete('eyes-open');shown.delete('mouth-neutral');shown.add('eyes-impact');shown.add('mouth-shock');shown.add('impact-lines')}
 if(key==='defeat'){shown.delete('eyes-open');shown.delete('mouth-neutral');shown.add('eyes-low');shown.add('mouth-low')}
 if(key==='repeat'){shown.delete('mouth-neutral');shown.add('mouth-question');shown.add('brow-question');shown.add('question-mark')}
 if(app.classList.contains('ultimate-ready'))shown.add('brow-ready');
 parts.forEach(part=>app.style.setProperty('--face-'+part,shown.has(part)?'inline':'none'));
 app.style.setProperty('--face-shield-dash',key==='guardIntent'?'7 5':'none');app.style.setProperty('--face-shield-opacity',key==='guardIntent'?'.65':'1');
}

export function renderCompanion(app, battle, view) {
  const key = view.visual;
  app.className = 'app state-' + key;
  app.dataset.state = key;
  app.classList.toggle('ultimate-ready', view.ultimate === 'ready');
  app.classList.toggle('impact-active', key === 'hurt');
  const unknown = !battle || key === 'offline';
  app.classList.toggle('resource-unknown', unknown);
  app.querySelectorAll('.hardware').forEach(node => { node.dataset.state = key; });
  const palettes = {defending:['#253e4f','#385b72','#233b50'],listening:['#173e42','#326b68','#163f43'],hurt:['#633f33','#83533d','#49362e'],defeat:['#343749','#494c66','#2b3043'],victory:['#3b5034','#6a7d41','#344b32']};
  const colors = palettes[key] || ['#183f37','#427f55','#1d493c'];
  ['--screen-base','--screen-center','--screen-edge'].forEach((name,i) => app.style.setProperty(name,colors[i]));
  app.style.setProperty('--light', key === 'hurt' ? '#e7ad8e' : key === 'defeat' ? '#a3a8c8' : key === 'accepted' ? '#f1cf8c' : '#84d6af');
  const track = app.querySelector('.track');
  const fighter = battle?.you;
  app.querySelector('#hp-fill').style.width = fighter ? (fighter.hp / fighter.maxHp * 100) + '%' : '0%';
  track.setAttribute('aria-label', unknown ? '生命值待核实' : '生命值' + fighter.hp + '，上限' + fighter.maxHp);
  app.querySelectorAll('.energy-point').forEach((node,i) => node.classList.toggle('on', !unknown && i < fighter.ap));
  app.querySelector('#energy-dots').setAttribute('aria-label',unknown ? '能量待核实' : '能量' + fighter.ap + '点');
  const ultimate = app.querySelector('#ultimate');
  ultimate.dataset.availability = view.ultimate;
  ultimate.setAttribute('aria-label', {ready:'当前可释放大招',used:'本局大招已用',ended:'对局已结束',unknown:'大招状态待核实',insufficient:'当前不可释放大招'}[view.ultimate]);
  app.querySelector('.buddy').setAttribute('aria-label','伙伴表情：' + key);
  refreshFace(app,key);
}

/** Only public snapshot fields; never display invented defaults or pending damage. */
export function opponentDetails(battle, connected) {
  if (!connected) return '连接或行动结果待核实，暂不展示缓存的对手数值。';
  if (!battle) return '尚无对局，没有对手状态。';
  if (battle.waiting) return '对方还没有接受挑战。';
  const foe = battle.opponent;
  const phase = battle.phase === 'victory' ? '对手已被击倒'
    : battle.phase === 'defeat' ? '对手获胜'
    : battle.pending?.actor === 'player' ? '对手需要应对本方攻击'
    : battle.pending?.actor === 'enemy' ? '对手已出招，等待本方应对'
    : battle.active === 'enemy' ? '对手主动阶段' : '等待本方主动出招';
  return '生命值：' + foe.hp + ' / ' + foe.maxHp
    + '\n能量：' + foe.ap + ' / ' + foe.maxAp
    + '\n大招：' + (foe.ultLeft > 0 ? '剩余' + foe.ultLeft + '次' : '本局已用')
    + '\n状态：' + phase;
}

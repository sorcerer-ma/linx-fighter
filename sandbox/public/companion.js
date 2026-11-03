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

/** 两条资源行：第一行自己，第二行对手；等对手加入时只留自己。 */
export function resourceRows(battle) {
  if (!battle) return [];
  const rows = [{ key: 'self', fighter: battle.you }];
  if (!battle.waiting && battle.opponent) rows.push({ key: 'opponent', fighter: battle.opponent });
  return rows;
}

/** 对手大招徽记：资源够且本局还有次数才亮，不等对手回合。 */
export function opponentUltimate(battle) {
  if (!battle || battle.waiting || !battle.opponent) return 'hidden';
  if (battle.phase !== 'battle') return 'ended';
  if (battle.opponent.ultLeft <= 0) return 'used';
  return battle.opponent.ap >= 4 ? 'ready' : 'insufficient';
}

const ULT_LABEL = { ready: '大招可释放', used: '本局大招已用', ended: '对局已结束', unknown: '大招状态待核实', insufficient: '大招未就绪' };

function paintRow(app, selectors, fighter, unknown) {
  const fill = app.querySelector(selectors.fill);
  const track = app.querySelector(selectors.track);
  const number = app.querySelector(selectors.number);
  const dots = app.querySelectorAll(selectors.dots + ' .energy-point');
  if (!fighter || unknown) {
    fill.style.width = '0%';
    number.textContent = '--';
    track.setAttribute('aria-label', selectors.name + '待核实');
    dots.forEach(node => node.classList.remove('on'));
    return;
  }
  const ratio = fighter.maxHp > 0 ? fighter.hp / fighter.maxHp : 0;
  fill.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  number.textContent = String(fighter.hp);
  track.setAttribute('aria-label', selectors.name + fighter.hp + '，上限' + fighter.maxHp);
  dots.forEach((node, i) => node.classList.toggle('on', i < fighter.ap));
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

  const resources = app.querySelector('.resources');
  const selfBadge = app.querySelector('#ultimate');
  const foeBadge = app.querySelector('#ultimate-enemy');
  const foe = battle?.opponent || null;
  const showFoe = Boolean(battle) && !battle.waiting && Boolean(foe);
  resources.hidden = !battle;
  app.querySelector('#self-row').hidden = !battle;
  app.querySelector('#opponent-row').hidden = !showFoe;
  selfBadge.hidden = !battle;
  foeBadge.hidden = !showFoe;

  paintRow(app, { fill: '#hp-fill', track: '.self .track', number: '#hp-number', dots: '#energy-dots', name: '自己生命值' }, battle?.you, unknown);
  if (showFoe) {
    paintRow(app, { fill: '#opponent-hp-fill', track: '.opponent .track', number: '#opponent-hp-number', dots: '#opponent-energy-dots', name: '对手生命值' }, foe, unknown);
  }
  selfBadge.dataset.availability = view.ultimate;
  selfBadge.setAttribute('aria-label', ULT_LABEL[view.ultimate] || ULT_LABEL.unknown);
  const foeUlt = opponentUltimate(battle);
  foeBadge.dataset.availability = foeUlt;
  foeBadge.setAttribute('aria-label', foeUlt === 'hidden' ? '对手大招' : '对手' + ULT_LABEL[foeUlt]);
  app.querySelector('.buddy').setAttribute('aria-label','伙伴表情：' + key);
  refreshFace(app,key);
}

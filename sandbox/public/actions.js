/**
 * 出招按钮的纯函数：把服务端快照翻译成底栏按钮组。
 *
 * 页面只把按钮变成中文原话交给 say()；这里不结算、不推演数值，
 * 只依据快照里公开的回合、资源与等待状态决定按钮是否可点。
 */

// 主动阶段四个招式；顺序与玩法文档一致：普攻、强攻、蓄力、大招。
var ACTIVE_BUTTONS = [
  { id: 'light', label: '普攻', command: '普攻', apCost: 1, tone: 'attack' },
  { id: 'heavy', label: '强攻', command: '强攻', apCost: 2, tone: 'attack' },
  { id: 'charge', label: '蓄力', command: '蓄力', apCost: 0, tone: 'calm' },
  { id: 'ult', label: '大招', command: '大招', apCost: 4, tone: 'ult' },
];

// 对手已锁定招式后的三个应对；承受不耗能量。
var RESPONSE_BUTTONS = [
  { id: 'guard', label: '格挡', command: '格挡', apCost: 1, tone: 'defend' },
  { id: 'dodge', label: '闪避', command: '闪避', apCost: 1, tone: 'defend' },
  { id: 'take', label: '承受', command: '承受', apCost: 0, tone: 'risk' },
];

function resourceNote(button, you) {
  // 大招和普通攻击的禁用原因不同：先看本局次数，再看能量。
  if (button.id === 'ult' && you.ultLeft <= 0) return '本局已用';
  if (you.ap < button.apCost) return '需要' + button.apCost + '点能量';
  return '';
}

function buttonsWithState(buttons, you, locked) {
  return buttons.map(function (button) {
    var note = resourceNote(button, you);
    return {
      id: button.id,
      label: button.label,
      command: button.command,
      apCost: button.apCost,
      disabled: locked || Boolean(note),
      tone: button.tone,
      note: note,
    };
  });
}

function withLock(hint, lockHint) {
  return lockHint ? hint + ' ' + lockHint : hint;
}

// 进行中的双人局给一个低干扰退出入口；放在招式网格外，避免和出招误触。
function leaveUtility(battle, locked) {
  if (!battle || battle.mode !== 'pvp') return null;
  if (battle.phase === 'victory' || battle.phase === 'defeat') return null;
  return {
    id: 'leave',
    label: '退出房间',
    command: '退出房间',
    confirm: '现在退出会判负，确定退出？',
    disabled: locked,
    tone: 'ghost',
  };
}

/**
 * 出招按钮视图。
 *
 * @param battle 服务端快照（可能为空）
 * @param options {busy?: boolean, connected?: boolean}
 * @returns {mode, hint, buttons: [{id,label,command,disabled,tone,note}], utility: object|null}
 */
export function actionBarView(battle, options) {
  var opts = options || {};
  var busy = opts.busy === true;
  var connected = opts.connected !== false;
  if (!battle) return { mode: 'lobby', hint: '', buttons: [], utility: null };
  if (battle.waiting) return { mode: 'waiting', hint: '房间已开，等对手加入。', buttons: [], utility: null };

  var you = battle.you && typeof battle.you === 'object'
    ? { ap: Number(battle.you.ap) || 0, ultLeft: Number(battle.you.ultLeft) || 0 }
    : { ap: 0, ultLeft: 0 };
  var locked = busy || !connected;
  var lockHint = !connected
    ? '连接断开，行动结果待核实；恢复后再出招。'
    : busy ? '正在等伙伴回复。' : '';
  var pending = battle.pending || null;

  // 对局结束：双人局只能回大厅（服务端会把「再来一局」拆成单人局），单人局给再来一局。
  if (battle.phase === 'victory' || battle.phase === 'defeat') {
    var won = battle.phase === 'victory';
    var pvp = battle.mode === 'pvp';
    var ending = pvp ? '回大厅再开一局？' : '再来一局？';
    var result = won ? '这一局赢了。' : '这一局结束了。';
    var endButton = pvp
      ? { id: 'lobby', label: '回到大厅', command: '退出房间', disabled: locked, tone: 'ghost', note: '' }
      : { id: 'rematch', label: '再来一局', command: '再来一局', disabled: locked, tone: 'attack', note: '' };
    return { mode: 'ended', hint: withLock(result + ending, lockHint), buttons: [endButton], utility: null };
  }

  // 对手已锁定招式：给三个应对，并把招式与伤害写在按钮上方。
  if (pending && pending.actor === 'enemy') {
    var label = pending.moveLabel || '招式';
    var damage = typeof pending.damage === 'number' ? pending.damage : null;
    var hint = '对手的「' + label + '」已锁定' +
      (damage === null ? '' : '，伤害 ' + damage) + '；选一种应对。';
    return {
      mode: 'respond',
      hint: withLock(hint, lockHint),
      buttons: buttonsWithState(RESPONSE_BUTTONS, you, locked),
      utility: leaveUtility(battle, locked),
    };
  }

  // 自己已经出招、等对手应对：pending.actor 是出招方，此时 active 仍停在自己这边。
  if (pending && pending.actor === 'player') {
    return {
      mode: 'wait',
      hint: withLock('你的「' + (pending.moveLabel || '招式') + '」已锁定，等对手应对。', lockHint),
      buttons: buttonsWithState(ACTIVE_BUTTONS, you, true),
      utility: leaveUtility(battle, locked),
    };
  }

  // 对手正在挑选招式（还没锁定）：按钮保留但禁用，不让底栏在等待时突然空掉。
  if (battle.active === 'enemy') {
    return {
      mode: 'wait',
      hint: withLock('对手正在行动，等它出招。', lockHint),
      buttons: buttonsWithState(ACTIVE_BUTTONS, you, true),
      utility: leaveUtility(battle, locked),
    };
  }

  // 轮到自己主动出招。
  return {
    mode: 'active',
    hint: withLock('轮到你了：选一招，也可以直接说话。', lockHint),
    buttons: buttonsWithState(ACTIVE_BUTTONS, you, locked),
    utility: leaveUtility(battle, locked),
  };
}

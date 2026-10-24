import type { AttributionMode } from '../config.js';
import { readCommand, type Command } from './command.js';
import { narrateSeatListening } from './narrator.js';
import type { Side } from './types.js';

/** 座位口令由房间座位决定，与设备无关：房主是红方，加入者是蓝方 */
const SEAT_WORDS: Record<Side, string> = { player: '红方', enemy: '蓝方' };

/** 这个座位的口令词；归属判定与自报座位的引导语都要用到 */
export function seatWord(seat: Side): string {
  return SEAT_WORDS[seat];
}

/** 严格模式下这一句话的归属判定：放行、用自己的口令重读一遍、或者干脆不作声 */
export type SeatScreen =
  /** text 是摘掉座位口令之后、要真正理解的那句原话 */
  | { kind: 'pass'; command: Command; text: string }
  | { kind: 'say'; text: string }
  | { kind: 'silent' };

/** 把口令从原话里摘掉，保留其余内容；摘完为空说明只报了个座位号 */
function stripWords(text: string, words: string[]): string {
  return words.reduce((rest, word) => rest.split(word).join(' '), text);
}

/**
 * 按座位口令判归属：只解决「这句话是替谁说的」，不解决「是谁在说」。
 *
 * 两台设备共用同一个智能体时，服务端拿不到说话人身份（平台侧声纹被拦时我们收不到任何请求），
 * 所以这里只能走显式约定：双人房两个座位各有一个短口令，玩家开口先报座位号。
 * - 带了对方座位号：这句话不是冲本机说的，静默丢掉，不回长句、不推进对局；
 * - 带了自己的座位号：口令只是归属标签，摘掉后重新读一遍，`红方大招` 照样是出大招；
 * - 什么都没带：沿用原来的轮次仲裁（当值方才执行，替对手喊招会被挡回）。
 */
export function screenSeat(
  mode: AttributionMode,
  seat: Side | null,
  text: string,
  command: Command,
): SeatScreen {
  // 单人局没有对方，也没座位可选，一律按原行为走
  if (mode !== 'strict' || seat === null) return { kind: 'pass', command, text };

  const own = SEAT_WORDS[seat];
  const other = SEAT_WORDS[seat === 'player' ? 'enemy' : 'player'];
  const spoken = text.toLowerCase();

  if (!spoken.includes(own)) {
    return spoken.includes(other) ? { kind: 'silent' } : { kind: 'pass', command, text };
  }

  const rest = stripWords(spoken, [own, other]);
  if (!rest.trim()) return { kind: 'say', text: narrateSeatListening(own) };
  // 口令摘掉之后的原话才是要认的那句：`红方开大` 不能在「开大」被削掉之后认不出来
  return { kind: 'pass', command: readCommand(rest), text: rest };
}

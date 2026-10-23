/**
 * 对局专用随机数。
 *
 * 不用 Math.random：同一场对局的每一次抽取都由「种子 + 已抽取次数」决定，
 * 这样读档、回放、单测都能得到完全一致的结果。
 */

/** 32 位混合，把种子与序号打散成一个均匀的 [0, 1) 浮点数 */
export function randomAt(seed: number, drawIndex: number): number {
  let x = (seed + Math.imul(drawIndex + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x / 0x100000000;
}

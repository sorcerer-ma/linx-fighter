/**
 * CPython MT19937 精确移植，只用于和 PR #1 的 Python 参考仿真对拍。
 *
 * 为什么要自己写：对拍要求逐位复现 Python 的随机序列，`Math.random` 与
 * 引擎里的 `randomAt` 都不行。这里按 CPython `Modules/_randommodule.c`
 * 的实现逐行翻译，包括两个容易踩的坑：
 *
 * 1. `random.seed(int)` 不是 `init_genrand(seed)`，而是把整数按 32 位
 *    小端切成 key 数组后走 `init_by_array`（version 2）；
 * 2. `random.random()` 是 res53：取两个 32 位输出，`(a>>5)*2^26 + (b>>6)`
 *    再除以 2^53，而不是常见的 53 位拼接后再乘 2^-53 的其他写法。
 *
 * 所有状态都按 uint32 保存，乘法一律用 `Math.imul` 保证 32 位回绕；
 * res53 的分子小于 2^53，在 double 里可精确表示，因此结果与 CPython
 * 逐位一致（seed=20261023 的前 5 个值见 test/simulation.test.ts）。
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** 2^53，res53 的分母 */
const TWO_POW_53 = 9007199254740992;

export class Mt19937 {
  /** 624 个 32 位状态字 */
  private readonly state = new Uint32Array(N);
  /** 下一个待输出的状态字下标；等于 N 表示需要先 twist */
  private index = N;

  constructor(seed: number) {
    this.seedInt(seed);
  }

  /**
   * 等价于 CPython `random.seed(int)`：
   * 取绝对值 → 按 32 位小端切分成 key 数组 → `init_by_array`。
   * 0 也对应一个长度 1 的 key（CPython 的 keyused 至少为 1）。
   */
  seedInt(seed: number): void {
    const abs = Math.abs(Math.trunc(seed));
    const key: number[] = [];
    let rest = abs;
    do {
      key.push(rest % 0x100000000);
      rest = Math.floor(rest / 0x100000000);
    } while (rest > 0);
    this.initByArray(key);
  }

  /** 对应 `init_genrand`：单参数播种的基础版本 */
  private initGenrand(seed: number): void {
    const mt = this.state;
    mt[0] = seed >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1]!;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  /** 对应 `init_by_array`：CPython 播种 int 实际走的路径（version 2） */
  private initByArray(key: number[]): void {
    const mt = this.state;
    this.initGenrand(19650218);

    let i = 1;
    let j = 0;
    // 第一轮：把 key 混进状态
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1]!;
      const mixed = mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525);
      mt[i] = ((mixed >>> 0) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }

    // 第二轮：再打散一次
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1]!;
      const mixed = mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941);
      mt[i] = (mixed - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1]!;
        i = 1;
      }
    }

    mt[0] = 0x80000000; // 最高位置 1，保证状态非零
    this.index = N;
  }

  /** 对应 `genrand_uint32`：每 624 次输出做一次 twist + 回火 */
  private genrandUint32(): number {
    const mt = this.state;

    if (this.index >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = (mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk]! & UPPER_MASK) | (mt[kk + 1]! & LOWER_MASK);
        mt[kk] = (mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      const y = (mt[N - 1]! & UPPER_MASK) | (mt[0]! & LOWER_MASK);
      mt[N - 1] = (mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.index = 0;
    }

    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** 对应 CPython `random.random()`：res53，返回值落在 [0, 1) */
  random(): number {
    const a = this.genrandUint32() >>> 5;
    const b = this.genrandUint32() >>> 6;
    return (a * 67108864 + b) / TWO_POW_53;
  }
}

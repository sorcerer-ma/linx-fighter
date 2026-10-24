import { createCommandRouter } from './src/game/router.js';

const key = process.env.OPENROUTER_KEY ?? '';
const loggingFetch = (async (url: string, init?: RequestInit) => {
  const t0 = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(2500) });
  const text = await res.text();
  const brief = JSON.parse(text)?.answers?.command;
  console.log(`   raw ${res.status} ${Date.now() - t0}ms`, JSON.stringify(brief));
  return new Response(text, { status: res.status });
}) as typeof fetch;

const router = createCommandRouter({
  apiKey: key,
  baseUrl: 'https://openrouter.ai/api',
  decisionPath: '/alpha/decisions',
  model: 'typesafe/jev-1.13',
  timeoutMs: 2500,
  fetchImpl: loggingFetch,
});

const cases: Array<[string, 'active' | 'response']> = [
  ['躲一下', 'active'],
  ['给他点颜色看看', 'active'],
  ['搞他', 'active'],
  ['来一手', 'active'],
  ['普攻', 'response'],
  ['格挡', 'response'],
];
for (const [text, stage] of cases) {
  console.log(`${stage} ${text}`);
  console.log('   ->', JSON.stringify(await router.resolve(text, stage)));
}

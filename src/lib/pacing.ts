/**
 * 抓取限速基础原语。
 *
 * 单独成文件是为了让 `wechat.ts` 与 `assets.ts` 共用同一套节流/退避实现，
 * 同时避免两者互相 import 造成循环依赖。
 */

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** 指数退避 + 抖动，避免多任务同时重试再次撞上配额 */
export function backoffDelay(attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  return Math.round(baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5));
}

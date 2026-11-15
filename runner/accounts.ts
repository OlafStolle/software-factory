import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Only provider stream events; never infer a quota from arbitrary agent prose.
export function quotaReset(stream: string, now = Date.now()): number | null {
  let info: any;
  for (const line of stream.split('\n')) {
    try { const event = JSON.parse(line); if (event.type === 'rate_limit_event') info = event.rate_limit_info; } catch {}
  }
  if (info?.status !== 'rejected' || info.isUsingOverage === true) return null;
  const reported = Number(info.resetsAt) * 1000;
  return Number.isFinite(reported) && reported > now ? Math.min(reported, now + 7 * 86400000) : now + 15 * 60000;
}
export function accountUntil(dataDir: string, account: string): number {
  try { const n = JSON.parse(readFileSync(join(dataDir, 'account-cooldowns.json'), 'utf8'))[account]; return Number.isFinite(n) ? n : 0; }
  catch (e: any) { if (e.code === 'ENOENT') return 0; throw e; }
}
export function coolAccount(dataDir: string, account: string, until: number) {
  let state: Record<string, number> = {};
  const file = join(dataDir, 'account-cooldowns.json');
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  state[account] = Math.max(state[account] ?? 0, until);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(file + '.tmp', file);
}

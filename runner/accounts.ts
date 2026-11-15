import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

function stateAt(file: string): Record<string, number> {
  let state: unknown;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') return {}; throw e; }
  if (!state || Array.isArray(state) || typeof state !== 'object' || Object.values(state).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('Invalid account cooldown state');
  return state as Record<string, number>;
}
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
  const state = stateAt(join(dataDir, 'account-cooldowns.json'));
  return Object.hasOwn(state, account) ? state[account] : 0;
}
export function coolAccount(dataDir: string, account: string, until: number) {
  const file = join(dataDir, 'account-cooldowns.json');
  const state = stateAt(file);
  state[account] = Math.max(state[account] ?? 0, until);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 }); renameSync(file + '.tmp', file);
}

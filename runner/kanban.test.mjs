import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardsFrom, renderBoard, refresh, refreshOrchestration, registryProjection, createKanbanServer, listenLoopback } from './kanban.mjs';

test('Registry projects known states and claims, filters other repositories and excludes raw data', () => {
  const projection = registryProjection({
    sources: [{ id: 's1', repository: 'owner/repo', open: true, checkedAt: '2026-11-02T00:00:00Z' }],
    tasks: [
      { id: 't1', repository: 'owner/repo', issueNumber: 1328, sourceId: 's1', state: 'executable', claimedBy: 'worker1', assignedActor: 'worker1', revision: 3, result: 'SECRET_RESULT' },
      { id: 't2', repository: 'other/repo', state: 'blocked' },
      { id: 't3', repository: 'owner/repo', state: 'review_ready' },
    ], actors: [{ id: 'worker1', role: 'builder', token: 'SECRET_TOKEN' }], audit: 'SECRET_AUDIT',
  }, 'owner/repo');
  assert.equal(projection.tasks.length, 2);
  assert.equal(projection.tasks[0].stateLabel, 'Ausführbar');
  assert.equal(projection.tasks[1].stateLabel, 'Bereit zum Review');
  const html = renderBoard({ registry: { ...projection, updatedAt: 'now' } });
  assert.ok(html.includes('Claim: worker1'));
  assert.ok(html.includes('Quellstatus nicht aktuell bestätigt'));
  assert.ok(!html.includes('SECRET_'));
});

test('Registry fetch is fixed loopback GET with private bearer; failure preserves last snapshot', async () => {
  const state = {};
  const run = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:13739/api/orchestration/v1/overview');
    assert.equal(options.headers.Authorization, 'Bearer SECRET_VALUE');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, text: async () => JSON.stringify({ sources: [], tasks: [], actors: [] }) };
  };
  await refreshOrchestration(state, '/token', 'owner/repo', run, async () => 'SECRET_VALUE\n');
  const timestamp = state.registry.updatedAt;
  assert.ok(timestamp);
  await refreshOrchestration(state, '/token', 'owner/repo', async () => { throw new Error('SECRET_VALUE'); }, async () => 'SECRET_VALUE');
  assert.equal(state.registry.updatedAt, timestamp);
  assert.deepEqual(state.registry.tasks, []);
  const html = renderBoard(state);
  assert.ok(html.includes('Registry-Abruf fehlgeschlagen'));
  assert.ok(!html.includes('SECRET_VALUE'));
  const untouched = {};
  await refreshOrchestration(untouched, '', 'owner/repo', run);
  assert.equal(untouched.registry, undefined);
});

test('Pilot priority, draft/review states and known PR links are preserved', () => {
  const cards = cardsFrom([{ number: 1, state: 'OPEN' }, { number: 1408, state: 'OPEN' }, { number: 1411, state: 'CLOSED' }], [{ number: 1412, state: 'OPEN', isDraft: true }]);
  assert.equal(cards.at(-1).number, 1);
  assert.equal(cards.find(x => x.number === 1408).column, 'In Arbeit');
  assert.equal(cards.find(x => x.number === 1411).column, 'Erledigt');
});

test('HTML escapes issue/runtime text and rejects non-GitHub links', () => {
  const html = renderBoard({ issues: [{ number: 1, title: '<script>alert(1)</script>', url: 'javascript:alert(1)', labels: [], state: 'OPEN', body: 'PRIVATE_BODY' }] }, { workers: [{ id: '<img src=x>', state: 'unknown' }], secret: 'SECRET_VALUE' });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('PRIVATE_BODY'));
  assert.ok(!html.includes('SECRET_VALUE'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
});

test('Missing runtime and failed refresh are explicit and retain last good data', async () => {
  const state = { issues: [{ number: 1, title: 'kept' }], prs: [], updatedAt: '2026-11-14T00:00:00Z' };
  await refresh(state, 'owner/repo', async () => { throw new Error('TOKEN_SECRET'); });
  const html = renderBoard(state);
  assert.equal(state.issues[0].title, 'kept');
  assert.ok(html.includes('2026-11-14T00:00:00Z'));
  assert.ok(html.includes('nicht eingerichtet'));
  assert.ok(html.includes('veraltet'));
  assert.ok(!html.includes('TOKEN_SECRET'));
});

test('Query limit is explicit; truncation is reported and errors clear after success', async () => {
  const state = { error: 'old error' };
  await refresh(state, 'owner/repo', async (_file, args) => {
    assert.equal(args[args.indexOf('--limit') + 1], args.includes('closed') ? '100' : '1000');
    return { stdout: JSON.stringify(args[0] === 'issue' ? Array.from({ length: 1000 }, (_, number) => ({ number })) : []) };
  });
  assert.equal(state.truncated, true);
  assert.equal(state.error, '');
  assert.ok(renderBoard(state).includes('möglicherweise unvollständig'));
});

test('Malformed runtime and invalid render data do not crash HTTP service', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'runtime.json');
  await writeFile(file, JSON.stringify({ hosts: [null], workers: [null] }));
  const state = {};
  const server = createKanbanServer(state, file);
  await listenLoopback(server, 0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.ok((await (await fetch(url)).text()).includes('Snapshot fehlt oder ist ungültig'));
  state.issues = [null];
  assert.equal((await fetch(url)).status, 503);
  state.issues = [];
  assert.equal((await fetch(url)).status, 200);
});

test('HTTP listens only on loopback, permits GET only and does not expose files', async t => {
  const server = createKanbanServer({}, '/nonexistent/runtime.json');
  await listenLoopback(server, 0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().address, '127.0.0.1');
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok((await response.text()).includes('Snapshot fehlt'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/etc/passwd`)).status, 404);
  const external = Object.values(networkInterfaces()).flat().find(x => x.family === 'IPv4' && !x.internal);
  if (external) await assert.rejects(fetch(`http://${external.address}:${port}/`, { signal: AbortSignal.timeout(2000) }));
});

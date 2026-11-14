import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const pilot = new Set([1328, 1408, 1411, 1414]);
const linkedPrs = { 1328: [1413], 1408: [1412] };
const columns = ['Backlog', 'In Arbeit', 'Review', 'Blockiert', 'Erledigt'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const githubUrl = value => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/.test(value ?? '') ? value : '#';
const registryStates = { executable: 'Ausführbar', waiting_plan: 'Plan fehlt', needs_info: 'Rückfrage', review_ready: 'Bereit zum Review', blocked: 'Blockiert' };

export function registryProjection(data, repo) {
  if (!Array.isArray(data.tasks) || !Array.isArray(data.sources) || !Array.isArray(data.actors)) throw new Error('invalid overview');
  const sources = new Map(data.sources.filter(source => source?.repository === repo).map(source => [source.id, source]));
  return {
    tasks: data.tasks.filter(task => task?.repository === repo).map(task => ({
      id: task.id, issueNumber: task.issueNumber, state: task.state, stateLabel: registryStates[task.state] || task.state || 'Unbekannt',
      claimedBy: task.claimedBy, assignedActor: task.assignedActor, paused: task.paused === true, revision: task.revision,
      sourceOpen: sources.get(task.sourceId)?.open, sourceCheckedAt: sources.get(task.sourceId)?.checkedAt,
    })),
    actors: data.actors.filter(actor => actor && typeof actor === 'object').map(actor => ({ id: actor.id, role: actor.role })),
  };
}

export async function refreshOrchestration(state, tokenFile, repo, fetcher = fetch, read = readFile) {
  if (!tokenFile) return;
  state.registry ??= {};
  try {
    const token = (await read(tokenFile, 'utf8')).trim();
    if (!token || token.length > 4096 || /\s/.test(token)) throw new Error('invalid token');
    const response = await fetcher('http://127.0.0.1:13739/api/orchestration/v1/overview', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error('overview unavailable');
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('overview too large');
    Object.assign(state.registry, registryProjection(JSON.parse(text), repo), { updatedAt: new Date().toISOString(), error: '' });
  } catch {
    state.registry.error = 'Registry-Abruf fehlgeschlagen. Vorhandener Stand bleibt erhalten und ist möglicherweise veraltet.';
  }
}

function registryHtml(registry) {
  if (!registry) return '<p>Operative Registry noch nicht angebunden.</p>';
  const tasks = registry.tasks ?? [];
  const counts = new Map();
  for (const task of tasks) counts.set(task.stateLabel, (counts.get(task.stateLabel) ?? 0) + 1);
  return `<details open><summary>Operative Registry · ${tasks.length} Aufgaben · ${tasks.filter(task => task.claimedBy).length} mit Claim</summary><p>Letzter erfolgreicher Abruf: ${escape(registry.updatedAt || 'noch keiner')}</p>${registry.error ? `<p class="warning">${escape(registry.error)}</p>` : ''}<p>${[...counts].map(([name, count]) => `${escape(name)}: ${count}`).join(' · ')}</p><p>Registrierte Akteure: ${(registry.actors ?? []).map(actor => `${escape(actor.id)} (${escape(actor.role)})`).join(', ') || 'kein Nachweis'}. Registrierung ist kein Nachweis eines laufenden Workers. Physische Ressourcen: siehe separater Snapshot.</p><details><summary>Aufträge und Claims anzeigen</summary>${tasks.map(task => `<p>Issue #${escape(task.issueNumber)} · ${escape(task.id)} · ${escape(task.stateLabel)}${task.paused ? ' · PAUSIERT' : ''} · Claim: ${escape(task.claimedBy || 'keiner')} · Zugewiesen: ${escape(task.assignedActor || 'keiner')} · Revision ${escape(task.revision ?? '?')} · Quelle geprüft: ${escape(task.sourceCheckedAt || 'unbekannt')}${!task.sourceCheckedAt || Date.now() - Date.parse(task.sourceCheckedAt) > 180000 ? ' (Quellstatus nicht aktuell bestätigt)' : ''}</p>`).join('')}</details></details>`;
}

export function cardsFrom(issues, prs) {
  return issues.map(issue => {
    const labels = (issue.labels ?? []).map(label => label.name);
    const related = prs.filter(pr => (pr.closingIssuesReferences ?? []).some(ref => ref.number === issue.number) || (linkedPrs[issue.number] ?? []).includes(pr.number));
    const open = related.filter(pr => pr.state === 'OPEN');
    let column = 'Backlog';
    if (issue.state === 'CLOSED') column = 'Erledigt';
    else if (labels.some(label => /^(blocked|blockiert|factory:(failed|question|rejected))$/i.test(label))) column = 'Blockiert';
    else if (open.some(pr => !pr.isDraft) || labels.some(label => /^(factory:(review|accepting)|review)$/i.test(label))) column = 'Review';
    else if (open.length || labels.some(label => /^(factory:(working|checking)|in.progress|in.arbeit)$/i.test(label))) column = 'In Arbeit';
    return { ...issue, related, column, theme: pilot.has(issue.number) ? 'Aufträge und Rechnungen' : 'Weiterer Backlog' };
  }).sort((a, b) => Number(pilot.has(b.number)) - Number(pilot.has(a.number)) || b.number - a.number);
}

export function renderBoard(state, runtime = null, runtimeError = '') {
  const cards = cardsFrom(state.issues ?? [], state.prs ?? []);
  const cardHtml = card => `<article><span class="theme">${escape(card.theme)}</span><h3><a href="${escape(githubUrl(card.url))}" rel="noreferrer">#${escape(card.number)} ${escape(card.title)}</a></h3><small>GitHub: ${escape(card.state)} · ${escape((card.labels ?? []).map(x => x.name).join(', ') || 'keine Statuslabels')}</small>${card.related.map(pr => `<p><a href="${escape(githubUrl(pr.url))}" rel="noreferrer">PR #${escape(pr.number)}</a> · ${escape(pr.state)}${pr.isDraft ? ' · Entwurf' : ''}</p>`).join('')}<p class="muted">Factory-Zuweisung: siehe Laufzeitstatus; aus GitHub nicht ableitbar.</p></article>`;
  const runtimeHtml = runtime ? `<p>Snapshot: ${escape(runtime.updatedAt || 'Zeitpunkt unbekannt')} · ${escape(runtime.status || 'Zustand unbekannt')}</p><h3>Rechner</h3>${(Array.isArray(runtime.hosts) ? runtime.hosts : []).map(host => `<p>${escape(host.name)} · freie Slots ${escape(host.freeSlots ?? 'unbekannt')} · RAM frei ${escape(host.memoryAvailableGiB ?? '?')} GiB · Platte frei ${escape(host.diskFreeGiB ?? '?')} GiB</p>`).join('')}<h3>Worker</h3>${(Array.isArray(runtime.workers) ? runtime.workers : []).map(worker => `<p>${escape(worker.id)} · ${escape(worker.host)} · ${escape(worker.state)} · Auftrag ${escape(worker.issue ?? 'keiner')}</p>`).join('')}<p>Bereinigung: ${escape(runtime.cleanup?.status ?? 'kein Nachweis')} · zuletzt ${escape(runtime.cleanup?.lastRun ?? 'unbekannt')}</p>` : '<p>Factory-Laufzeitstatus nicht eingerichtet. Worker, Claims und Bereinigung sind hier noch nicht nachgewiesen.</p>';
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Nuova Vita · Factory Kanban</title><style>body{font:16px system-ui,sans-serif;background:#f4f6f8;color:#17212e;margin:0;padding:24px}h1{margin:0 0 12px}a{color:#124f9d}header,details{max-width:1500px;margin:0 auto 24px}.board{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:16px;overflow:auto;padding-bottom:16px}section{background:#e6ebf1;padding:12px;border-radius:10px}section h2{font-size:18px}article{padding:16px;background:white;border:1px solid #cdd6e1;border-radius:8px;margin:12px 0}h3{font-size:16px;margin:8px 0}p{line-height:1.5}.theme{font-size:12px;font-weight:700}.muted,small{font-size:12px;color:#46556a}.warning{padding:12px;background:#fff0d0;border:1px solid #a96b00}summary{cursor:pointer;font-weight:700}</style><header><h1>Nuova Vita · Factory Kanban</h1><p>Priorität: Aufträge und Rechnungen. Lesende Ansicht aus GitHub; keine zweite Aufgabenqueue. Erledigt zeigt die zuletzt angelegten 100 geschlossenen Issues.</p><p>Letzter erfolgreicher GitHub-Abruf: <strong>${escape(state.updatedAt || 'noch keiner')}</strong> · Abruf alle 60 Sekunden</p>${state.error ? `<p class="warning">${escape(state.error)} Vorhandene Daten bleiben sichtbar und können veraltet sein.</p>` : ''}${state.truncated ? '<p class="warning">Mindestens eine Abfrage erreicht 1.000 Einträge. Die Ansicht ist möglicherweise unvollständig.</p>' : ''}<p class="muted">Spalten werden aus offen/geschlossen, Statuslabels und verknüpften PRs abgeleitet. Ein geschlossenes Issue ist kein Nachweis für Deployment oder fachliche Abnahme. Bekannte Pilotverknüpfungen: #1328 → PR #1413, #1408 → PR #1412.</p></header>${registryHtml(state.registry)}<details open><summary>Factory-Laufzeitstatus (separater Nachweis)</summary>${runtimeHtml}${runtimeError ? `<p class="warning">${escape(runtimeError)}</p>` : ''}</details><main class="board">${columns.map(column => `<section aria-label="${column}"><h2>${column} · ${cards.filter(card => card.column === column).length}</h2>${cards.filter(card => card.column === column).map(cardHtml).join('') || '<p>Keine Einträge im letzten Abruf.</p>'}</section>`).join('')}</main></html>`;
}

export async function refresh(state, repo, run = exec) {
  try {
    const [issues, closedIssues, prs] = await Promise.all([
      run('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number,title,url,state,labels'], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }),
      run('gh', ['issue', 'list', '--repo', repo, '--state', 'closed', '--limit', '100', '--json', 'number,title,url,state,labels'], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }),
      run('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,url,state,isDraft,closingIssuesReferences'], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    const nextIssues = JSON.parse(issues.stdout);
    const nextClosed = JSON.parse(closedIssues.stdout);
    const nextPrs = JSON.parse(prs.stdout);
    if (![nextIssues, nextClosed, nextPrs].every(Array.isArray)) throw new Error('invalid response');
    const combined = [...new Map([...nextIssues, ...nextClosed].map(issue => [issue.number, issue])).values()];
    Object.assign(state, { issues: combined, prs: nextPrs, updatedAt: new Date().toISOString(), error: '', truncated: [nextIssues, nextPrs].some(items => items.length >= 1000) });
  } catch {
    // CLI errors can contain credentials or private payloads; never render their text.
    state.error = 'GitHub-Abruf fehlgeschlagen. Anmeldung, Verbindung und gh-Konfiguration serverseitig prüfen.';
  }
}

async function readRuntime(path) {
  if (!path) return [null, ''];
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 256000) throw new Error('too large');
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
    for (const key of ['hosts', 'workers']) {
      if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(item => !item || typeof item !== 'object' || Array.isArray(item)))) throw new Error('invalid');
    }
    const age = Date.now() - Date.parse(data.updatedAt);
    return [data, !Number.isFinite(age) || age > 180000 || age < -60000 ? 'Factory-Snapshot ist veraltet oder hat keinen gültigen Zeitpunkt; angezeigte Zustände sind nicht als aktuell bestätigt.' : ''];
  } catch {
    return [null, 'Factory-Snapshot fehlt oder ist ungültig.'];
  }
}

export function createKanbanServer(state, runtimePath = '') {
  return createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" };
    if (req.method !== 'GET') { res.writeHead(405, { ...headers, Allow: 'GET' }); res.end(); return; }
    if (req.url !== '/') { res.writeHead(404, headers); res.end(); return; }
    try {
      const [runtime, error] = await readRuntime(runtimePath);
      const html = renderBoard(state, runtime, error);
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Kanban-Daten vorübergehend ungültig. Nächsten Abruf abwarten.');
    }
  });
}

export function listenLoopback(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FACTORY_KANBAN_PORT || 4310);
  const repo = process.env.FACTORY_KANBAN_REPO || 'OlafStolle/Nuova-Vita';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid Kanban configuration');
  const state = { error: 'Erster GitHub-Abruf läuft.' };
  const server = createKanbanServer(state, process.env.FACTORY_RUNTIME_SNAPSHOT);
  await listenLoopback(server, port);
  const poll = async () => {
    await Promise.all([refresh(state, repo), refreshOrchestration(state, process.env.FACTORY_ORCHESTRATION_TOKEN_FILE, repo)]);
    setTimeout(poll, 60000).unref();
  };
  void poll();
  console.log(`Private Factory Kanban listening on 127.0.0.1:${port}`);
}

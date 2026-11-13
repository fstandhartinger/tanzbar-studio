// tanzbar-studio gateway v2: one shared conversation ("feed") for Michi's private studio on diskret-tanzbar.de.
//
// Browser (diskret-tanzbar.de/#studio=<token>, header X-Studio-Token or ?t=):
//   WS   /api/ui                 feed + jobs + material + previews, live (JSON)
//   WS   /api/voice              live voice: PCM16/24 kHz up (binary), assistant PCM down (binary) + JSON events
//   POST /api/chat               {text}                    chat message (text agent, or forwarded into a live voice call)
//   POST /api/chat/voice         raw audio                 voice message -> transcript -> same as chat
//   POST /api/material           raw file | {kind,text}    photos/files/texts/links for the next change request
//   DELETE /api/material/:id     GET /api/material/:id     GET /api/preview/:id/:n     GET /api/audio/:id     GET /api/state
// Runner (Sandy):
//   POST /api/runner/sync        Bearer RUNNER_SECRET      {jobs, versions, profile} -> {claim, previews, profile}
//   GET  /api/runner/material/:id                          POST /api/runner/preview/:id {status, images, note, error}
// Secrets only from env. Feed + intro flag persist through the runner (profile); binaries live in memory only.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { VOICE_INSTRUCTIONS, CHAT_INSTRUCTIONS, INTRO, TOOLS } from './instructions.js';
import { readSite } from './site.js';
import { xaiChat, describeImage, transcribe } from './llm.js';

const env = (k, d = '') => process.env[k] ?? d;
const PORT = Number(env('PORT', '8080'));
const TOKEN_HASH = env('STUDIO_TOKEN_SHA256').trim().toLowerCase();
const RUNNER_SECRET = env('RUNNER_SECRET').trim();
const XAI_KEY = env('XAI_API_KEY').trim();
const XAI_URL = env('XAI_REALTIME_URL', 'wss://api.x.ai/v1/realtime?model=grok-voice-3.0');
const VOICE = env('STUDIO_VOICE', 'eve');
const ORIGINS = new Set(env('ALLOWED_ORIGINS', 'https://diskret-tanzbar.de,https://www.diskret-tanzbar.de,https://diskret-tanzbar.onrender.com').split(',').map((s) => s.trim()).filter(Boolean));
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_SESSION_MS = Number(env('MAX_SESSION_MS', String(20 * 60_000)));
const MAX_SESSIONS_PER_DAY = Number(env('MAX_SESSIONS_PER_DAY', '40'));
const MAX_JOBS_PER_DAY = Number(env('MAX_JOBS_PER_DAY', '12'));
const MAX_OPEN_JOBS = Number(env('MAX_OPEN_JOBS', '3'));
const MAX_CHAT_PER_DAY = Number(env('MAX_CHAT_PER_DAY', '300'));
const MAX_PREVIEWS_PER_DAY = Number(env('MAX_PREVIEWS_PER_DAY', '40'));
const MAX_FILE = 12 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 120 * 1024 * 1024;
const DEBUG = Boolean(env('DEBUG_TRANSCRIPT'));

const log = (...a) => console.log(new Date().toISOString(), ...a);
const rid = (n = 4) => crypto.randomBytes(n).toString('hex');
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- auth
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function tokenOk(token) {
  if (!TOKEN_HASH || !token || token.length > 200) return false;
  const want = Buffer.from(TOKEN_HASH, 'hex'), got = sha(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function runnerOk(req) {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  return Boolean(RUNNER_SECRET && got) && crypto.timingSafeEqual(sha(got), sha(RUNNER_SECRET));
}
const fails = new Map();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const throttled = (ip) => { const f = fails.get(ip); return f && f.n >= 20 && Date.now() - f.t < 3600_000; };
const noteFail = (ip) => { const f = fails.get(ip) || { n: 0, t: 0 }; f.n += 1; f.t = Date.now(); fails.set(ip, f); };
const originOk = (o) => !o || ORIGINS.has(o) || LOCAL_ORIGIN.test(o);

// ---------------------------------------------------------------- store
const S = {
  jobs: new Map(), pending: new Map(),
  material: new Map(), previews: new Map(), audios: new Map(),
  versions: [], lastVersions: null, lastUnderstanding: 0, lastJobAt: 0,
  profile: { rev: 0, introDone: false, voiceIntroDone: false, feed: [] },
  runnerSeenAt: 0, day: '', count: { sessions: 0, jobs: 0, chat: 0, previews: 0 },
  voice: null, ui: new Set(), chatBusy: false, chatQueue: [],
};
function rollDay() { const d = nowIso().slice(0, 10); if (S.day !== d) { S.day = d; S.count = { sessions: 0, jobs: 0, chat: 0, previews: 0 }; } }
const OPEN = new Set(['queued', 'starting', 'running', 'publishing', 'deploying']);
const runnerOnline = () => Date.now() - S.runnerSeenAt < 45_000;
const touch = () => { S.profile.rev += 1; };

function publicJob(j) {
  return { id: j.id, type: j.type || 'change', createdAt: j.createdAt, updatedAt: j.updatedAt, title: j.title, points: j.points || [], status: j.status,
    progress: (j.progress || []).slice(-40), summary: j.summary || '', error: j.error || '', position: j.position ?? null };
}
const jobList = () => [...S.jobs.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 12).map(publicJob);
function publicMaterial(m) {
  return { id: m.id, kind: m.kind, name: m.name, mime: m.mime, size: m.size, text: m.text ? m.text.slice(0, 400) : '', url: m.url || '',
    description: m.description || '', createdAt: m.createdAt, jobId: m.jobId || null, available: Boolean(m.buf) || m.kind === 'text' || m.kind === 'url' };
}
const materialList = () => [...S.material.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(publicMaterial);

function broadcast(obj) { const s = JSON.stringify(obj); for (const c of S.ui) if (c.readyState === WebSocket.OPEN) c.send(s); }
const broadcastJobs = () => broadcast({ type: 'jobs', jobs: jobList(), runnerOnline: runnerOnline() });
const broadcastMaterial = () => broadcast({ type: 'material', material: materialList() });

function addFeed(item) {
  const it = { id: item.id || `f${rid(5)}`, t: nowIso(), ...item };
  S.profile.feed.push(it);
  if (S.profile.feed.length > 160) S.profile.feed = S.profile.feed.slice(-160);
  touch();
  broadcast({ type: 'feed', item: it });
  return it;
}
function updateFeed(id, patch) {
  const it = S.profile.feed.find((x) => x.id === id);
  if (!it) return null;
  Object.assign(it, patch);
  touch();
  broadcast({ type: 'feed', item: it });
  return it;
}

const matLine = (m) => (m.kind === 'text' || m.mkind === 'text' ? `Text "${(m.text || '').slice(0, 300)}"`
  : m.kind === 'url' || m.mkind === 'url' ? `Link ${m.url}`
  : `${(m.kind || m.mkind) === 'image' ? 'Bild' : 'Datei'} "${m.name}"${m.description ? ` – ${m.description}` : ''}`) + ` (id ${m.materialId || m.id})`;

function feedNote(x) {
  if (x.kind === 'understanding') return `Verständnis angezeigt: "${x.title}": ${x.points.join('; ')}`;
  if (x.kind === 'material') return x.removed ? '' : `Michi hat Material hinzugefügt: ${matLine(x)}`;
  if (x.kind === 'preview') return `Vorschau "${x.title}" (${x.status})${x.note ? `: ${x.note}` : ''}`;
  if (x.kind === 'sketch') return `Skizze angezeigt: ${x.title}: ${x.blocks.map((b) => `${b.name} (${b.status})`).join(', ')}`;
  if (x.kind === 'versions') return `Versionsliste angezeigt: ${x.list.map((v) => `Nr. ${v.nr} ${v.label}`).join('; ')}`;
  if (x.kind === 'note') return x.text;
  return '';
}
// a short text view of the recent conversation (voice greeting context)
function feedAsText(n = 14) {
  return S.profile.feed.slice(-n).map((x) => (x.kind === 'michi' ? `Michi: ${x.text}` : x.kind === 'agent' ? `Studio: ${x.text}` : (feedNote(x) ? `[${feedNote(x)}]` : ''))).filter(Boolean).join('\n');
}
function contextNote() {
  const open = jobList().filter((j) => OPEN.has(j.status));
  const unused = [...S.material.values()].filter((m) => !m.jobId);
  return [
    open.length ? `Laufende Aufträge: ${open.map((j) => `"${j.title}" (${j.status})`).join(', ')}.` : '',
    unused.length ? `Noch nicht verwendetes Material: ${unused.map((m) => matLine(m)).join(' | ')}.` : '',
  ].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- jobs
function createJob(fields) {
  rollDay();
  const open = [...S.jobs.values()].filter((j) => OPEN.has(j.status)).length;
  if (S.count.jobs >= MAX_JOBS_PER_DAY) return { error: `Tageslimit erreicht (${MAX_JOBS_PER_DAY} Aufträge). Morgen geht es weiter.` };
  if (open >= MAX_OPEN_JOBS) return { error: `Es laufen schon ${open} Aufträge. Bitte warten, bis einer fertig ist.` };
  const t = nowIso();
  const id = `${t.slice(0, 10).replace(/-/g, '')}-${rid(3)}`;
  const job = { id, createdAt: t, updatedAt: t, status: 'queued', progress: [{ t, text: 'Auftrag angenommen' }], ...fields };
  S.jobs.set(id, job); S.pending.set(id, job);
  S.count.jobs += 1; S.lastJobAt = Date.now();
  log('job created', id, job.type || 'change', job.title);
  broadcastJobs();
  return { job };
}
function statusText() {
  const list = jobList();
  if (!list.length) return 'Es gibt noch keine Aufträge.';
  const de = { queued: 'wartet', starting: 'startet', running: 'in Arbeit', publishing: 'wird veröffentlicht', deploying: 'wird veröffentlicht', live: 'ist online', failed: 'hat nicht geklappt' };
  return list.slice(0, 4).map((j) => {
    const last = j.progress.at(-1)?.text || '';
    return `"${j.title}": ${de[j.status] || j.status}${last ? ` (zuletzt: ${last})` : ''}${j.summary ? `. Ergebnis: ${j.summary}` : ''}${j.error ? `. Problem: ${j.error}` : ''}`;
  }).join(' | ') + (runnerOnline() ? '' : ' | Hinweis: Der Server, der die Aufträge abarbeitet, meldet sich gerade nicht. Aufträge bleiben gespeichert.');
}
function onJobStatus(job, prev) {
  if (job.status === 'live' && prev !== 'live') {
    addFeed({ kind: 'note', text: job.type === 'restore' ? `Wieder online: ${job.title.replace(/^Zurück zu: /, '')}` : `Online: ${job.title}`, jobId: job.id, live: true });
    S.voice?.note(`[System: Der Auftrag "${job.title}" ist jetzt online. ${job.summary || ''} Sag es Michi kurz, wenn es gerade passt.]`, false);
  }
  if (job.status === 'failed' && prev !== 'failed') addFeed({ kind: 'note', text: `Hat nicht geklappt: ${job.title}. ${job.error || ''}`, jobId: job.id, failed: true });
}
const deDate = (iso) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------- tools (shared by voice and chat)
async function runTool(name, a) {
  try {
    switch (name) {
      case 'seite_lesen': return await readSite();
      case 'status_abfragen': return statusText();
      case 'material_auflisten': {
        const list = [...S.material.values()];
        return list.length ? list.map((m) => `${matLine(m)}${m.jobId ? ' [schon in einem Auftrag]' : ''}`).join('\n') : 'Noch kein Material.';
      }
      case 'verstaendnis_zeigen': {
        const points = (Array.isArray(a.punkte) ? a.punkte : []).map((p) => String(p).slice(0, 220)).slice(0, 6);
        addFeed({ kind: 'understanding', title: String(a.titel || '').slice(0, 90), points });
        S.lastUnderstanding = Date.now();
        return 'Wird Michi jetzt angezeigt. Fasse es kurz zusammen und frag, ob es so passt.';
      }
      case 'auftrag_starten': {
        if (!S.lastUnderstanding || S.lastUnderstanding < S.lastJobAt || Date.now() - S.lastUnderstanding > 60 * 60_000) {
          return 'Noch nicht gestartet: Rufe zuerst verstaendnis_zeigen auf und hol dir Michis ausdrückliche Bestätigung.';
        }
        const ids = Array.isArray(a.material_ids) && a.material_ids.length ? a.material_ids : [...S.material.values()].filter((m) => !m.jobId).map((m) => m.id);
        const mats = ids.map((id) => S.material.get(id)).filter(Boolean);
        const r = createJob({
          type: 'change', title: String(a.titel || 'Änderung').slice(0, 120),
          points: (Array.isArray(a.punkte) ? a.punkte : []).map((p) => String(p).slice(0, 240)).slice(0, 8),
          spec: String(a.arbeitsanweisung || '').slice(0, 14000), confirmation: String(a.bestaetigung_wortlaut || '').slice(0, 500),
          transcript: S.profile.feed.filter((x) => x.kind === 'michi' || x.kind === 'agent').slice(-40).map((x) => ({ role: x.kind === 'michi' ? 'michi' : 'studio', text: x.text })),
          attachments: mats.map((m) => ({ id: m.id, kind: m.kind, name: m.name, mime: m.mime, size: m.size, text: m.text || '', url: m.url || '', description: m.description || '' })),
        });
        if (r.error) return `Nicht gestartet: ${r.error} Sag Michi das kurz.`;
        for (const m of mats) m.jobId = r.job.id;
        broadcastMaterial();
        addFeed({ kind: 'note', text: `Auftrag gestartet: ${r.job.title}${mats.length ? ` · ${mats.length} × Material dabei` : ''}`, jobId: r.job.id });
        const queued = [...S.jobs.values()].filter((j) => OPEN.has(j.status) && j.id !== r.job.id).length;
        return `Auftrag gestartet${queued ? `, als Nummer ${queued + 1} in der Warteschlange` : ''}. Sag Michi kurz, dass es läuft, ungefähr 10 bis 25 Minuten dauert, er den Fortschritt rechts sieht und die Seite zumachen kann.`;
      }
      case 'vorschau_erstellen': {
        rollDay();
        if (S.count.previews >= MAX_PREVIEWS_PER_DAY) return 'Für heute sind keine Vorschauen mehr möglich.';
        const page = /^\/(varianten\/(0[1-9]|10)\/)?$/.test(String(a.seite || '/')) ? String(a.seite || '/') : '/';
        const id = `p${rid(4)}`;
        const pv = { id, createdAt: nowIso(), page, area: String(a.bereich || '').slice(0, 200), change: String(a.aenderung || '').slice(0, 2000), device: a.geraet === 'handy' ? 'mobile' : 'desktop', status: 'queued', images: [], feedId: `f${rid(5)}` };
        S.previews.set(id, pv); S.count.previews += 1;
        if (S.previews.size > 40) S.previews.delete(S.previews.keys().next().value);
        addFeed({ id: pv.feedId, kind: 'preview', previewId: id, status: 'queued', title: pv.change ? pv.area : `So sieht es jetzt aus: ${pv.area}`, page, change: pv.change, device: pv.device, images: [] });
        return `Vorschau wird gebaut, dauert 20 bis 60 Sekunden. Sag Michi kurz, dass du sie baust${runnerOnline() ? '' : ' (der Vorschau-Server ist gerade nicht erreichbar, es kann länger dauern)'}. Du bekommst einen Hinweis, wenn sie fertig ist.`;
      }
      case 'skizze_zeigen': {
        const blocks = (Array.isArray(a.bloecke) ? a.bloecke : []).slice(0, 14).map((b) => ({ name: String(b.name || '').slice(0, 60), notiz: String(b.notiz || '').slice(0, 140), status: ['gleich', 'neu', 'weg', 'geaendert'].includes(b.status) ? b.status : 'gleich' }));
        addFeed({ kind: 'sketch', title: String(a.titel || 'Skizze').slice(0, 90), blocks });
        return 'Skizze wird angezeigt.';
      }
      case 'versionen_zeigen': {
        if (!S.versions.length) return 'Die Versionsliste ist gerade nicht verfügbar. Versuch es gleich noch mal.';
        const list = S.versions.slice(0, 10).map((v, i) => ({ nr: i + 1, sha: v.sha, date: v.date, label: v.label || v.subject, current: i === 0 }));
        S.lastVersions = { at: Date.now(), list };
        addFeed({ kind: 'versions', list: list.map(({ sha: _s, ...rest }) => rest) });
        return list.map((v) => `Nr. ${v.nr}${v.current ? ' (aktuell online)' : ''}: ${deDate(v.date)} – ${v.label}`).join('\n') + '\nFasse die Liste in einem Satz zusammen und frag, zu welcher Nummer er zurück will.';
      }
      case 'version_wiederherstellen': {
        const lv = S.lastVersions;
        if (!lv || Date.now() - lv.at > 45 * 60_000) return 'Zeig zuerst mit versionen_zeigen die Liste und hol dir Michis Bestätigung.';
        const v = lv.list.find((x) => x.nr === Number(a.nummer));
        if (!v) return 'Diese Nummer gibt es nicht in der Liste.';
        if (v.current) return 'Das ist schon die aktuelle Version.';
        const r = createJob({ type: 'restore', title: `Zurück zu: ${v.label}`.slice(0, 120), points: [`Version vom ${deDate(v.date)}`], restoreSha: v.sha, restoreLabel: v.label, confirmation: String(a.bestaetigung_wortlaut || '').slice(0, 300) });
        if (r.error) return `Nicht gestartet: ${r.error}`;
        addFeed({ kind: 'note', text: `Zurück zur Version vom ${deDate(v.date)} gestartet`, jobId: r.job.id });
        return 'Gestartet. Sag Michi, dass die Version in ein paar Minuten wieder online ist und auch das rückgängig gemacht werden kann.';
      }
      default: return 'Unbekanntes Werkzeug.';
    }
  } catch (e) {
    log('tool error', name, e.message);
    return 'Das hat gerade nicht geklappt. Sag Michi, er soll es gleich nochmal versuchen.';
  }
}

// ---------------------------------------------------------------- chat agent (text + voice messages)
function chatInput(text, via, extra = {}) {
  rollDay();
  if (S.count.chat >= MAX_CHAT_PER_DAY) { addFeed({ kind: 'note', text: 'Für heute ist Schluss mit Nachrichten. Morgen gerne wieder.' }); return; }
  S.count.chat += 1;
  addFeed({ kind: 'michi', text: String(text).slice(0, 4000), via, ...extra });
  if (S.voice?.ready) { S.voice.userText(text); return; } // a live call is running: the voice agent answers
  S.chatQueue.push(1);
  if (!S.chatBusy) drainChat();
}
async function drainChat() {
  S.chatBusy = true;
  while (S.chatQueue.length) {
    S.chatQueue.length = 0; // answer everything that arrived meanwhile in one turn
    broadcast({ type: 'typing', on: true });
    try { await chatTurn(); } catch (e) { log('chat error', e.message); addFeed({ kind: 'agent', via: 'chat', text: 'Da hakt gerade was. Schick deine Nachricht bitte gleich noch mal.' }); }
    broadcast({ type: 'typing', on: false });
  }
  S.chatBusy = false;
}
function chatMessages() {
  const intro = S.profile.introDone ? '' : `\n\n${INTRO}`;
  const ctx = contextNote();
  const msgs = [{ role: 'system', content: CHAT_INSTRUCTIONS + intro + (ctx ? `\n\n[System: ${ctx}]` : '') }];
  for (const x of S.profile.feed.slice(-36)) {
    if (x.kind === 'michi') msgs.push({ role: 'user', content: x.via === 'voicemsg' ? `(Sprachnachricht) ${x.text}` : x.via === 'voice' ? `(im Live-Gespräch gesagt) ${x.text}` : x.text });
    else if (x.kind === 'agent') msgs.push({ role: 'assistant', content: x.text });
    else { const n = feedNote(x); if (n) msgs.push({ role: 'user', content: `[System: ${n}]` }); }
  }
  return msgs;
}
async function chatTurn() {
  const msgs = chatMessages();
  if (!S.profile.introDone) { S.profile.introDone = true; touch(); }
  for (let i = 0; i < 6; i++) {
    const m = await xaiChat(msgs, { tools: TOOLS });
    const calls = m.tool_calls || [];
    if (!calls.length) {
      const text = String(m.content || '').trim();
      if (text) addFeed({ kind: 'agent', via: 'chat', text: text.slice(0, 4000) });
      return;
    }
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
    for (const c of calls) {
      let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* */ }
      const out = await runTool(c.function?.name, args);
      msgs.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
  }
}

// ---------------------------------------------------------------- material
async function addMaterial(m) {
  const used = () => [...S.material.values()].reduce((n, x) => n + (x.buf?.length || 0), 0);
  if (m.buf && used() + m.buf.length > MAX_MATERIAL_BYTES) {
    for (const x of [...S.material.values()].sort((p, q) => p.createdAt.localeCompare(q.createdAt))) if (x.jobId && x.downloaded) x.buf = null; // the job folder has its copy
    if (used() + m.buf.length > MAX_MATERIAL_BYTES) throw Object.assign(new Error('full'), { code: 413 });
  }
  const it = { id: `m${rid(4)}`, createdAt: nowIso(), jobId: null, description: '', feedId: `f${rid(5)}`, ...m };
  S.material.set(it.id, it);
  addFeed({ id: it.feedId, kind: 'material', materialId: it.id, mkind: it.kind, name: it.name, mime: it.mime, text: (it.text || '').slice(0, 400), url: it.url || '', description: '' });
  broadcastMaterial();
  const tell = () => S.voice?.note(`[System: Michi hat Material hinzugefügt: ${matLine(it)}. Bestätige kurz, dass du es hast. Ist unklar, wofür es ist, frag nach.]`, true);
  if (it.kind === 'image' && it.buf && /^image\/(jpeg|png|webp|gif)$/.test(it.mime)) {
    describeImage(it.buf, it.mime).then((d) => { it.description = d; updateFeed(it.feedId, { description: d }); broadcastMaterial(); tell(); })
      .catch((e) => { log('describe failed', e.message); tell(); });
  } else tell();
  return it;
}

// ---------------------------------------------------------------- http
function cors(req, res) {
  const o = req.headers.origin;
  if (o && originOk(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-studio-token, x-filename');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
function raw(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const bodyJson = async (req, max = 2_000_000) => { const b = await raw(req, max); return b.length ? JSON.parse(b.toString()) : {}; };
const sendBytes = (res, buf, mime) => { res.writeHead(200, { 'content-type': mime || 'application/octet-stream', 'cache-control': 'private, max-age=86400', 'content-length': buf.length }); res.end(buf); };

async function runnerRoute(req, res, p) {
  if (!runnerOk(req)) return json(res, 401, { ok: false });
  S.runnerSeenAt = Date.now();
  if (p === '/api/runner/sync' && req.method === 'POST') {
    const b = await bodyJson(req, 4_000_000);
    if (b.profile && typeof b.profile.rev === 'number' && (S.profile.rev === 0 || b.profile.rev > S.profile.rev)) {
      S.profile = { rev: b.profile.rev, introDone: Boolean(b.profile.introDone), voiceIntroDone: Boolean(b.profile.voiceIntroDone), feed: Array.isArray(b.profile.feed) ? b.profile.feed.slice(-160) : [] };
    }
    const known = new Set();
    for (const r of Array.isArray(b.jobs) ? b.jobs : []) {
      if (!r || typeof r.id !== 'string') continue;
      known.add(r.id); S.pending.delete(r.id);
      const prev = S.jobs.get(r.id) || {};
      const next = { ...prev, ...r };
      S.jobs.set(r.id, next);
      if (prev.status && prev.status !== next.status) onJobStatus(next, prev.status);
    }
    for (const [id] of S.jobs) if (!known.has(id) && !S.pending.has(id)) S.jobs.delete(id);
    if (Array.isArray(b.versions)) S.versions = b.versions.slice(0, 15);
    broadcastJobs();
    const previews = [...S.previews.values()].filter((v) => v.status === 'queued' || (v.status === 'claimed' && Date.now() - v.claimedAt > 4 * 60_000));
    for (const v of previews) { v.status = 'claimed'; v.claimedAt = Date.now(); updateFeed(v.feedId, { status: 'working' }); }
    return json(res, 200, {
      ok: true,
      claim: [...S.pending.values()].map((j) => ({ ...j })),
      previews: previews.map((v) => ({ id: v.id, page: v.page, area: v.area, change: v.change, device: v.device })),
      profile: S.profile.rev > (b.profile?.rev || 0) ? S.profile : undefined,
    });
  }
  let m = p.match(/^\/api\/runner\/material\/(m[0-9a-f]+)$/);
  if (m && req.method === 'GET') {
    const it = S.material.get(m[1]);
    if (!it?.buf) return json(res, 404, { ok: false });
    it.downloaded = true;
    return sendBytes(res, it.buf, it.mime);
  }
  m = p.match(/^\/api\/runner\/preview\/(p[0-9a-f]+)$/);
  if (m && req.method === 'POST') {
    const pv = S.previews.get(m[1]);
    if (!pv) return json(res, 404, { ok: false });
    const b = await bodyJson(req, 20_000_000);
    pv.status = b.status === 'done' ? 'done' : 'failed';
    pv.images = (Array.isArray(b.images) ? b.images : []).slice(0, 3).map((im) => ({ label: String(im.label || '').slice(0, 60), mime: im.mime || 'image/jpeg', buf: Buffer.from(String(im.b64 || ''), 'base64') }));
    pv.note = String(b.note || '').slice(0, 400);
    pv.error = String(b.error || '').slice(0, 200);
    updateFeed(pv.feedId, { status: pv.status, note: pv.note, error: pv.error, images: pv.images.map((im, i) => ({ label: im.label, n: i })) });
    if (S.voice?.ready) {
      S.voice.note(pv.status === 'done'
        ? `[System: Die Vorschau "${pv.area}" ist fertig und wird Michi jetzt gezeigt. ${pv.note} Sag ihm in ein, zwei Sätzen, was er sieht, und frag, ob es so gemeint war.]`
        : `[System: Die Vorschau "${pv.area}" hat nicht geklappt. Sag es Michi kurz.]`, true);
    } else if (pv.status === 'done') addFeed({ kind: 'agent', via: 'chat', text: pv.note || 'Hier ist die Vorschau.' });
    else addFeed({ kind: 'agent', via: 'chat', text: 'Die Vorschau hat leider nicht geklappt. Ich kann es noch mal versuchen, wenn du willst.' });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false });
}

async function browserRoute(req, res, p, url) {
  const ip = ipOf(req);
  if (throttled(ip)) return json(res, 429, { ok: false });
  if (!originOk(req.headers.origin)) return json(res, 403, { ok: false });
  if (!tokenOk(req.headers['x-studio-token'] || url.searchParams.get('t'))) { noteFail(ip); return json(res, 401, { ok: false }); }

  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, { ok: true, jobs: jobList(), runnerOnline: runnerOnline(), feed: S.profile.feed.slice(-80), material: materialList(), voiceActive: Boolean(S.voice?.ready) });
  }
  if (p === '/api/chat' && req.method === 'POST') {
    const text = String((await bodyJson(req, 50_000)).text || '').trim();
    if (!text) return json(res, 400, { ok: false });
    chatInput(text, 'chat');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/chat/voice' && req.method === 'POST') {
    const buf = await raw(req, 15 * 1024 * 1024);
    const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
    if (buf.length < 1500) return json(res, 400, { ok: false, message: 'Zu kurz.' });
    const audioId = `a${rid(4)}`;
    S.audios.set(audioId, { buf, mime, t: Date.now() });
    if (S.audios.size > 40) S.audios.delete(S.audios.keys().next().value);
    broadcast({ type: 'typing', on: true });
    let text = '';
    try { text = await transcribe(buf, mime); } catch (e) { log('stt error', e.message); }
    if (!text) { broadcast({ type: 'typing', on: S.chatBusy }); return json(res, 422, { ok: false, message: 'Ich konnte die Sprachnachricht nicht verstehen.' }); }
    chatInput(text, 'voicemsg', { audioId, mime });
    return json(res, 200, { ok: true, text });
  }
  if (p === '/api/material' && req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '');
    let it;
    if (ct.startsWith('application/json')) {
      const b = await bodyJson(req, 200_000);
      if (b.kind === 'url') {
        const u = String(b.url || b.text || '').trim();
        if (!/^https?:\/\/\S+$/i.test(u)) return json(res, 400, { ok: false, message: 'Das ist kein gültiger Link.' });
        it = await addMaterial({ kind: 'url', name: u.replace(/^https?:\/\//, '').slice(0, 80), url: u.slice(0, 2000), mime: 'text/uri-list', size: u.length });
      } else {
        const t = String(b.text || '').trim();
        if (!t) return json(res, 400, { ok: false });
        it = await addMaterial({ kind: 'text', name: String(b.name || 'Text').slice(0, 80), text: t.slice(0, 20000), mime: 'text/plain', size: t.length });
      }
    } else {
      const buf = await raw(req, MAX_FILE);
      const name = decodeURIComponent(String(req.headers['x-filename'] || 'datei')).replace(/[^\w.\- äöüÄÖÜß()]/g, '_').slice(0, 100) || 'datei';
      const mime = ct.split(';')[0] || 'application/octet-stream';
      it = await addMaterial({ kind: mime.startsWith('image/') ? 'image' : 'file', name, mime, size: buf.length, buf });
    }
    return json(res, 200, { ok: true, material: publicMaterial(it) });
  }
  let m = p.match(/^\/api\/material\/(m[0-9a-f]+)$/);
  if (m) {
    const it = S.material.get(m[1]);
    if (!it) return json(res, 404, { ok: false });
    if (req.method === 'GET') return it.buf ? sendBytes(res, it.buf, it.mime) : json(res, 404, { ok: false });
    if (req.method === 'DELETE') {
      if (it.jobId) return json(res, 409, { ok: false, message: 'Schon in einem Auftrag.' });
      S.material.delete(it.id);
      updateFeed(it.feedId, { removed: true });
      broadcastMaterial();
      S.voice?.note(`[System: Michi hat das Material "${it.name}" wieder entfernt.]`, false);
      return json(res, 200, { ok: true });
    }
  }
  m = p.match(/^\/api\/preview\/(p[0-9a-f]+)\/(\d)$/);
  if (m && req.method === 'GET') {
    const im = S.previews.get(m[1])?.images?.[Number(m[2])];
    return im?.buf?.length ? sendBytes(res, im.buf, im.mime) : json(res, 404, { ok: false });
  }
  m = p.match(/^\/api\/audio\/(a[0-9a-f]+)$/);
  if (m && req.method === 'GET') {
    const a = S.audios.get(m[1]);
    return a ? sendBytes(res, a.buf, a.mime) : json(res, 404, { ok: false });
  }
  return json(res, 404, { ok: false });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, runnerOnline: runnerOnline(), voice: Boolean(XAI_KEY) });
    if (p.startsWith('/api/runner/')) return await runnerRoute(req, res, p);
    if (p.startsWith('/api/')) return await browserRoute(req, res, p, url);
    return json(res, 404, { ok: false });
  } catch (e) {
    if (e.code === 413) return json(res, 413, { ok: false, message: 'Die Datei ist zu groß (max. 12 MB).' });
    log('http error', e.message);
    return json(res, 500, { ok: false });
  }
});

// ---------------------------------------------------------------- websockets
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const ip = ipOf(req);
  const ok = (url.pathname === '/api/voice' || url.pathname === '/api/ui') && Boolean(req.headers.origin) && originOk(req.headers.origin) && !throttled(ip) && tokenOk(url.searchParams.get('t'));
  if (!ok) {
    if (url.pathname.startsWith('/api/')) noteFail(ip);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => (url.pathname === '/api/ui' ? startUi(ws) : startVoice(ws)));
});

const WELCOME = `Hey Michi, willkommen im Studio. So läuft's: Du sagst oder schreibst mir, was sich an deiner Seite ändern soll. Ich fasse es zusammen, und erst nach deinem **Okay** baut ein Agent es und stellt es online, meist in 10 bis 25 Minuten.
- **Live sprechen:** einfach aufs Auge tippen
- **Nachrichten:** unten schreiben oder übers Mikro eine Sprachnachricht schicken
- **Material:** über das Plus Fotos, Texte oder Links dazulegen
- **Vorschau:** ich zeig dir vorher, wie eine Änderung aussähe
- **Zurück:** jede Version lässt sich wiederherstellen, sag einfach „zeig mir die Versionen“`;

function startUi(ws) {
  // first visit: a written welcome that explains everything once (later only on request)
  if (!S.profile.introDone && !S.profile.feed.length && S.runnerSeenAt) { S.profile.introDone = true; addFeed({ kind: 'agent', via: 'chat', text: WELCOME }); }
  S.ui.add(ws);
  ws.send(JSON.stringify({ type: 'init', feed: S.profile.feed.slice(-80), jobs: jobList(), material: materialList(), runnerOnline: runnerOnline(), voiceActive: Boolean(S.voice?.ready), typing: S.chatBusy }));
  const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 25_000);
  ws.on('close', () => { S.ui.delete(ws); clearInterval(ping); });
  ws.on('error', () => {});
}

function startVoice(client) {
  rollDay();
  const send = (o) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(o));
  if (!XAI_KEY) { send({ type: 'error', message: 'Die Sprach-KI ist gerade nicht eingerichtet.' }); return client.close(); }
  if (S.count.sessions >= MAX_SESSIONS_PER_DAY) { send({ type: 'error', message: 'Für heute ist Schluss mit Live-Gesprächen. Schreib mir gern unten.' }); return client.close(); }
  S.count.sessions += 1;
  if (S.voice) S.voice.close('replaced');
  const sid = rid(3);
  log('voice open', sid);
  let closed = false, ready = false, assistant = null; // assistant = {id, text} of the answer being spoken
  const pending = new Map();
  const up = new WebSocket(XAI_URL, { headers: { Authorization: `Bearer ${XAI_KEY}` }, handshakeTimeout: 10_000 });
  const upSend = (o) => up.readyState === WebSocket.OPEN && up.send(JSON.stringify(o));
  const timer = setTimeout(() => { send({ type: 'notice', message: 'Zeit ist um. Tipp das Auge noch mal an, wenn du weitermachen willst.' }); finish(); }, MAX_SESSION_MS);
  const session = {
    get ready() { return ready && !closed; },
    note(text, respond) { if (!ready || closed) return; upSend({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }); if (respond) upSend({ type: 'response.create' }); },
    userText(text) { this.note(`(Michi hat geschrieben) ${text}`, true); },
    close(why) { if (why === 'replaced') send({ type: 'notice', message: 'Das Gespräch läuft jetzt in einem anderen Fenster.' }); finish(); },
  };
  S.voice = session;

  function flushAssistant() {
    if (assistant && assistant.text.trim()) {
      if (DEBUG) log('studio:', assistant.text.trim());
      addFeed({ id: assistant.id, kind: 'agent', via: 'voice', text: assistant.text.trim().slice(0, 3000) });
    }
    assistant = null;
  }
  function finish() {
    if (closed) return; closed = true;
    clearTimeout(timer);
    flushAssistant();
    if (S.voice === session) { S.voice = null; broadcast({ type: 'voice', active: false }); }
    try { up.close(); } catch { /* */ }
    try { client.close(); } catch { /* */ }
    log('voice closed', sid);
  }

  up.on('unexpected-response', (_r, res) => { log('xai http', res.statusCode); send({ type: 'error', message: 'Die Sprach-KI ist gerade nicht erreichbar. Schreib mir solange unten.' }); finish(); });
  up.on('error', (e) => { log('xai error', e.message); send({ type: 'error', message: 'Verbindung zur Sprach-KI fehlgeschlagen.' }); finish(); });
  up.on('close', () => finish());
  up.on('open', () => upSend({
    type: 'session.update',
    session: {
      voice: VOICE, instructions: VOICE_INSTRUCTIONS,
      turn_detection: { type: 'server_vad', silence_duration_ms: Number(env('VAD_SILENCE_MS', '900')) },
      tools: TOOLS.map((t) => ({ type: 'function', ...t })),
      audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language_hint: 'de' } }, output: { format: { type: 'audio/pcm', rate: 24000 } } },
    },
  }));

  up.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.type) {
      case 'session.updated': {
        if (ready) break;
        ready = true;
        send({ type: 'ready' });
        broadcast({ type: 'voice', active: true });
        const hist = feedAsText(12);
        const ctx = contextNote();
        const intro = S.profile.voiceIntroDone ? '' : ` ${INTRO} (Im Verlauf steht schon eine schriftliche Erklärung; sag es trotzdem kurz mündlich, weil es sein erstes Live-Gespräch ist.)`;
        if (!S.profile.voiceIntroDone) { S.profile.voiceIntroDone = true; S.profile.introDone = true; touch(); }
        session.note(`[System, nicht von Michi: Michi hat gerade das Live-Gespräch gestartet.${hist ? ` Bisheriger Verlauf (Chat und frühere Gespräche):\n${hist}\n` : ''}${ctx ? ` ${ctx}` : ''} Begrüße ihn in einem kurzen, coolen Satz${hist ? ', knüpf wenn sinnvoll an den Verlauf an' : ''} und frag, was sich an seiner Seite ändern soll.${intro}]`, true);
        break;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (client.readyState === WebSocket.OPEN) client.send(Buffer.from(m.delta, 'base64'));
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (!assistant) assistant = { id: `f${rid(5)}`, text: '' };
        assistant.text += m.delta || '';
        broadcast({ type: 'agent_delta', id: assistant.id, delta: m.delta || '' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (m.transcript && String(m.transcript).trim()) { if (DEBUG) log('michi:', m.transcript); addFeed({ kind: 'michi', via: 'voice', text: String(m.transcript).trim().slice(0, 2000) }); }
        break;
      case 'input_audio_buffer.speech_started': send({ type: 'speech_started' }); break;
      case 'input_audio_buffer.speech_stopped': send({ type: 'speech_stopped' }); break;
      case 'response.created': send({ type: 'thinking' }); break;
      case 'response.function_call_arguments.done': {
        let args = {}; try { args = JSON.parse(m.arguments || '{}'); } catch { /* */ }
        send({ type: 'tool', name: m.name });
        pending.set(m.call_id, runTool(m.name, args));
        break;
      }
      case 'response.done': {
        flushAssistant();
        send({ type: 'turn_done' });
        if (pending.size) {
          const calls = [...pending]; pending.clear();
          const outs = await Promise.all(calls.map(([id, pr]) => pr.then((out) => [id, out])));
          for (const [id, out] of outs) upSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: out } });
          upSend({ type: 'response.create' });
        }
        break;
      }
      case 'error': log('xai event error', m.error?.message); break;
      default:
    }
  });

  client.on('message', (data, isBinary) => {
    if (isBinary) { if (ready && data.length <= 9600) upSend({ type: 'input_audio_buffer.append', audio: Buffer.from(data).toString('base64') }); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'stop') finish();
  });
  client.on('close', finish);
  client.on('error', finish);
}

server.listen(PORT, () => log(`tanzbar-studio v2 on :${PORT} voice=${Boolean(XAI_KEY)} token=${Boolean(TOKEN_HASH)} runner=${Boolean(RUNNER_SECRET)} stt=${Boolean(env('GROQ_API_KEY') || env('OPENAI_API_KEY'))}`));

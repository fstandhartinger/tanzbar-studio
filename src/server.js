// tanzbar-studio: voice gateway + change-request queue for diskret-tanzbar.de.
//
//  Browser (diskret-tanzbar.de/#studio=<token>)
//    GET  /api/state            X-Studio-Token        -> jobs + runner liveness (also the token check)
//    WS   /api/voice?t=<token>                         -> PCM16/24 kHz up (binary), assistant PCM down (binary) + JSON events
//  Runner (Sandy, ~/bin/tanzbar-studio-runner)
//    POST /api/runner/sync      Authorization: Bearer <RUNNER_SECRET>   {jobs:[...]} -> {claim:[new requests]}
//
// Secrets come only from env: STUDIO_TOKEN_SHA256, RUNNER_SECRET, XAI_API_KEY. Nothing is persisted here: the runner
// owns job state (it re-sends every job it knows on each sync), this process only holds unclaimed requests.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { INSTRUCTIONS, TOOLS } from './instructions.js';
import { readSite } from './site.js';

const env = (k, d = '') => process.env[k] ?? d;
const PORT = Number(env('PORT', '8080'));
const TOKEN_HASH = env('STUDIO_TOKEN_SHA256').trim().toLowerCase();
const RUNNER_SECRET = env('RUNNER_SECRET').trim();
const XAI_KEY = env('XAI_API_KEY').trim();
const XAI_URL = env('XAI_REALTIME_URL', 'wss://api.x.ai/v1/realtime?model=grok-voice-3.0');
const VOICE = env('STUDIO_VOICE', 'eve');
const ORIGINS = new Set(env('ALLOWED_ORIGINS', 'https://diskret-tanzbar.de,https://www.diskret-tanzbar.de,https://diskret-tanzbar.onrender.com').split(',').map((s) => s.trim()).filter(Boolean));
const MAX_SESSION_MS = Number(env('MAX_SESSION_MS', String(15 * 60_000)));
const MAX_SESSIONS_PER_DAY = Number(env('MAX_SESSIONS_PER_DAY', '40'));
const MAX_JOBS_PER_DAY = Number(env('MAX_JOBS_PER_DAY', '10'));
const MAX_OPEN_JOBS = Number(env('MAX_OPEN_JOBS', '3'));

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- auth ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function tokenOk(token) {
  if (!TOKEN_HASH || !token || token.length > 200) return false;
  const want = Buffer.from(TOKEN_HASH, 'hex');
  const got = sha(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function runnerOk(req) {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!RUNNER_SECRET || !got) return false;
  const a = sha(got), b = sha(RUNNER_SECRET);
  return crypto.timingSafeEqual(a, b);
}
// brute-force brake: failed token checks per IP
const fails = new Map();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function throttled(ip) { const f = fails.get(ip); return f && f.n >= 20 && Date.now() - f.t < 3600_000; }
function noteFail(ip) { const f = fails.get(ip) || { n: 0, t: Date.now() }; f.n += 1; f.t = Date.now(); fails.set(ip, f); }

// ---------- state ----------
const state = {
  jobs: new Map(), // id -> job (runner view for claimed jobs, local view for pending ones)
  pending: new Map(), // id -> request not yet acknowledged by the runner
  runnerSeenAt: 0,
  day: '',
  sessionsToday: 0,
  jobsToday: 0,
  activeVoice: null,
};
const today = () => new Date().toISOString().slice(0, 10);
function rollDay() { const d = today(); if (state.day !== d) { state.day = d; state.sessionsToday = 0; state.jobsToday = 0; } }

const OPEN = new Set(['queued', 'starting', 'running', 'publishing', 'deploying']);
function publicJob(j) {
  return {
    id: j.id, createdAt: j.createdAt, updatedAt: j.updatedAt, title: j.title, points: j.points, status: j.status,
    progress: (j.progress || []).slice(-40), summary: j.summary || '', error: j.error || '', position: j.position ?? null,
  };
}
function jobList() {
  return [...state.jobs.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 12).map(publicJob);
}
const runnerOnline = () => Date.now() - state.runnerSeenAt < 45_000;

function createJob({ titel, punkte, arbeitsanweisung, bestaetigung_wortlaut }, transcript) {
  rollDay();
  const open = [...state.jobs.values()].filter((j) => OPEN.has(j.status)).length;
  if (state.jobsToday >= MAX_JOBS_PER_DAY) return { error: `Tageslimit erreicht (${MAX_JOBS_PER_DAY} Aufträge). Morgen geht es weiter.` };
  if (open >= MAX_OPEN_JOBS) return { error: `Es laufen schon ${open} Aufträge. Bitte warten, bis einer fertig ist.` };
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const job = {
    id, createdAt: now, updatedAt: now, status: 'queued',
    title: String(titel || 'Änderung').slice(0, 120),
    points: (Array.isArray(punkte) ? punkte : []).map((p) => String(p).slice(0, 240)).slice(0, 8),
    spec: String(arbeitsanweisung || '').slice(0, 12000),
    confirmation: String(bestaetigung_wortlaut || '').slice(0, 500),
    transcript: transcript.slice(-60),
    progress: [{ t: now, text: 'Auftrag angenommen' }],
  };
  state.jobs.set(id, job);
  state.pending.set(id, job);
  state.jobsToday += 1;
  log('job created', id, job.title);
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
  }).join(' | ') + (runnerOnline() ? '' : ' | Hinweis: Der Server, der die Aufträge abarbeitet, meldet sich gerade nicht. Aufträge bleiben gespeichert, bis er wieder da ist.');
}

// ---------- http ----------
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.has(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-studio-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req, max = 2_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, runnerOnline: runnerOnline(), voice: Boolean(XAI_KEY) });
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const ip = ipOf(req);
      if (throttled(ip)) return json(res, 429, { ok: false });
      if (!tokenOk(req.headers['x-studio-token'])) { noteFail(ip); return json(res, 401, { ok: false }); }
      return json(res, 200, { ok: true, jobs: jobList(), runnerOnline: runnerOnline() });
    }
    if (url.pathname === '/api/runner/sync' && req.method === 'POST') {
      if (!runnerOk(req)) return json(res, 401, { ok: false });
      const b = await body(req);
      state.runnerSeenAt = Date.now();
      const known = new Set();
      for (const r of Array.isArray(b.jobs) ? b.jobs : []) {
        if (!r || typeof r.id !== 'string') continue;
        known.add(r.id);
        state.pending.delete(r.id);
        const prev = state.jobs.get(r.id) || {};
        state.jobs.set(r.id, { ...prev, ...publicJob({ ...prev, ...r }) });
      }
      // drop finished jobs the runner no longer reports (pruned there)
      for (const [id, j] of state.jobs) if (!known.has(id) && !state.pending.has(id)) state.jobs.delete(id);
      broadcastJobs();
      const claim = [...state.pending.values()].map((j) => ({ id: j.id, createdAt: j.createdAt, title: j.title, points: j.points, spec: j.spec, confirmation: j.confirmation, transcript: j.transcript }));
      return json(res, 200, { ok: true, claim });
    }
    return json(res, 404, { ok: false });
  } catch (e) {
    log('http error', e.message);
    return json(res, 500, { ok: false });
  }
});

// ---------- voice ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const clients = new Set();
function broadcastJobs() {
  const msg = JSON.stringify({ type: 'jobs', jobs: jobList(), runnerOnline: runnerOnline() });
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const ip = ipOf(req);
  const origin = req.headers.origin || '';
  const okOrigin = ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (url.pathname !== '/api/voice' || !okOrigin || throttled(ip) || !tokenOk(url.searchParams.get('t'))) {
    if (url.pathname === '/api/voice') noteFail(ip);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => startVoice(ws));
});

function startVoice(client) {
  rollDay();
  const send = (o) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(o));
  if (!XAI_KEY) { send({ type: 'error', message: 'Die Sprach-KI ist gerade nicht eingerichtet.' }); return client.close(); }
  if (state.sessionsToday >= MAX_SESSIONS_PER_DAY) { send({ type: 'error', message: 'Für heute ist Schluss. Morgen gerne wieder.' }); return client.close(); }
  state.sessionsToday += 1;
  // one live conversation at a time: a new tab replaces the old one
  if (state.activeVoice) try { state.activeVoice.close(4000, 'replaced'); } catch { /* gone */ }
  state.activeVoice = client;
  clients.add(client);
  const sid = crypto.randomBytes(3).toString('hex');
  log('voice open', sid);

  const transcript = []; // [{role, text}]
  let assistantBuf = '';
  let shown = false; // verstaendnis_zeigen was called in this session
  let closed = false;
  const up = new WebSocket(XAI_URL, { headers: { Authorization: `Bearer ${XAI_KEY}` }, handshakeTimeout: 10_000 });
  const upSend = (o) => up.readyState === WebSocket.OPEN && up.send(JSON.stringify(o));
  const timer = setTimeout(() => { send({ type: 'notice', message: 'Zeit ist um. Tipp das Auge noch mal an, wenn du weitermachen willst.' }); finish(); }, MAX_SESSION_MS);

  function finish() {
    if (closed) return; closed = true;
    clearTimeout(timer);
    clients.delete(client);
    if (state.activeVoice === client) state.activeVoice = null;
    try { up.close(); } catch { /* */ }
    try { client.close(); } catch { /* */ }
    log('voice closed', sid, `turns=${transcript.length}`);
  }

  up.on('unexpected-response', (_r, res) => { log('xai http', res.statusCode); send({ type: 'error', message: 'Die Sprach-KI ist gerade nicht erreichbar.' }); finish(); });
  up.on('error', (e) => { log('xai error', e.message); send({ type: 'error', message: 'Verbindung zur Sprach-KI fehlgeschlagen.' }); finish(); });
  up.on('close', () => finish());
  up.on('open', () => {
    upSend({
      type: 'session.update',
      session: {
        voice: VOICE,
        instructions: INSTRUCTIONS,
        turn_detection: { type: 'server_vad', silence_duration_ms: Number(env('VAD_SILENCE_MS', '900')) },
        tools: TOOLS.map((t) => ({ type: 'function', ...t })),
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language_hint: 'de' } },
          output: { format: { type: 'audio/pcm', rate: 24000 } },
        },
      },
    });
  });

  let ready = false;
  const pendingCalls = new Map();
  up.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.type) {
      case 'session.updated':
        if (ready) break;
        ready = true;
        send({ type: 'ready' });
        send({ type: 'jobs', jobs: jobList(), runnerOnline: runnerOnline() });
        {
          const open = jobList().filter((j) => OPEN.has(j.status));
          const note = open.length ? ` Gerade läuft schon: ${open.map((j) => `"${j.title}"`).join(', ')}. Erwähne das in einem halben Satz.` : '';
          upSend({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Hinweis vom System, nicht von Michi: Michi hat gerade das Studio geöffnet. Begrüße ihn in einem kurzen, coolen Satz und frag, was sich an seiner Seite ändern soll.${note}]` }] } });
          upSend({ type: 'response.create' });
        }
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (client.readyState === WebSocket.OPEN) client.send(Buffer.from(m.delta, 'base64'));
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        assistantBuf += m.delta || '';
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (m.transcript) transcript.push({ role: 'michi', text: String(m.transcript).slice(0, 2000) });
        if (env('DEBUG_TRANSCRIPT') && m.transcript) log('michi:', m.transcript);
        break;
      case 'input_audio_buffer.speech_started':
        send({ type: 'speech_started' });
        break;
      case 'input_audio_buffer.speech_stopped':
        send({ type: 'speech_stopped' });
        break;
      case 'response.created':
        send({ type: 'thinking' });
        break;
      case 'response.function_call_arguments.done': {
        let args = {}; try { args = JSON.parse(m.arguments || '{}'); } catch { /* */ }
        send({ type: 'tool', name: m.name });
        pendingCalls.set(m.call_id, runTool(m.name, args));
        break;
      }
      case 'response.done': {
        if (env('DEBUG_TRANSCRIPT') && assistantBuf.trim()) log('studio:', assistantBuf.trim());
        if (assistantBuf.trim()) { transcript.push({ role: 'studio', text: assistantBuf.trim().slice(0, 2000) }); assistantBuf = ''; }
        send({ type: 'turn_done' });
        if (pendingCalls.size) {
          const calls = [...pendingCalls];
          pendingCalls.clear();
          const outs = await Promise.all(calls.map(([id, p]) => p.then((out) => [id, out])));
          for (const [id, out] of outs) upSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: out } });
          upSend({ type: 'response.create' });
        }
        break;
      }
      case 'error':
        log('xai event error', m.error?.message);
        break;
      default:
    }
  });

  async function runTool(name, a) {
    try {
      if (name === 'seite_lesen') return await readSite();
      if (name === 'status_abfragen') return statusText();
      if (name === 'verstaendnis_zeigen') {
        shown = true;
        const punkte = (Array.isArray(a.punkte) ? a.punkte : []).map((p) => String(p).slice(0, 200)).slice(0, 6);
        send({ type: 'understanding', title: String(a.titel || '').slice(0, 80), points: punkte });
        return 'Wird Michi jetzt angezeigt. Fasse es kurz mündlich zusammen und frag, ob es so passt.';
      }
      if (name === 'auftrag_starten') {
        if (!shown) return 'Noch nicht gestartet: Rufe zuerst verstaendnis_zeigen auf und hol dir Michis ausdrückliche Bestätigung.';
        const r = createJob(a, transcript);
        if (r.error) { send({ type: 'notice', message: r.error }); return `Nicht gestartet: ${r.error} Sag Michi das kurz.`; }
        send({ type: 'job_started', job: publicJob(r.job) });
        shown = false;
        const queued = [...state.jobs.values()].filter((j) => OPEN.has(j.status) && j.id !== r.job.id).length;
        return `Auftrag gestartet${queued ? ` und als Nummer ${queued + 1} in die Warteschlange gestellt` : ''}. Sag Michi in ein, zwei Sätzen, dass es läuft, ungefähr 10 bis 25 Minuten dauert, er den Fortschritt hier sieht und die Seite auch zumachen kann.`;
      }
      return 'Unbekanntes Werkzeug.';
    } catch (e) {
      log('tool error', name, e.message);
      return 'Das hat gerade nicht geklappt. Sag Michi, er soll es gleich nochmal versuchen.';
    }
  }

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ready && data.length <= 9600) upSend({ type: 'input_audio_buffer.append', audio: Buffer.from(data).toString('base64') });
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'stop') finish();
  });
  client.on('close', finish);
  client.on('error', finish);
}

server.listen(PORT, () => log(`tanzbar-studio on :${PORT} voice=${Boolean(XAI_KEY)} token=${Boolean(TOKEN_HASH)} runner=${Boolean(RUNNER_SECRET)}`));

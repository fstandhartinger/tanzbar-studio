// xAI chat (text agent + image descriptions) and speech-to-text (Groq Whisper, OpenAI fallback).
const XAI_KEY = () => (process.env.XAI_API_KEY || '').trim();
const CHAT_MODEL = () => process.env.CHAT_MODEL || 'grok-4.7';

export async function xaiChat(messages, { tools, maxTokens = 900, timeoutMs = 60_000 } = {}) {
  const body = { model: CHAT_MODEL(), messages, max_tokens: maxTokens };
  if (tools?.length) { body.tools = tools.map((t) => ({ type: 'function', function: t })); body.tool_choice = 'auto'; }
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${XAI_KEY()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`xai chat HTTP ${r.status}`);
  const d = await r.json();
  return d.choices?.[0]?.message ?? { content: '' };
}

export async function describeImage(buf, mime) {
  const msg = await xaiChat([{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      { type: 'text', text: 'Beschreibe dieses Bild in ein bis zwei deutschen Sätzen für einen Webdesigner: Motiv, Stimmung, Farben, Format (hoch/quer), lesbarer Text. Keine Einleitung.' },
    ],
  }], { maxTokens: 220, timeoutMs: 40_000 });
  return String(msg.content || '').trim().slice(0, 600);
}

async function whisper(url, key, model, buf, mime, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  fd.append('model', model);
  fd.append('language', 'de');
  fd.append('prompt', 'Michael Mirage, Diskret Tanzbar, Sets, Startseite, Afterhour, Variante, SoundCloud, Instagram.');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`stt HTTP ${r.status}`);
  return String((await r.json()).text || '').trim();
}

export async function transcribe(buf, mime) {
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : 'webm';
  const name = `nachricht.${ext}`;
  const groq = (process.env.GROQ_API_KEY || '').trim();
  const openai = (process.env.OPENAI_API_KEY || '').trim();
  if (groq) {
    try { return await whisper('https://api.groq.com/openai/v1/audio/transcriptions', groq, 'whisper-large-v3', buf, mime, name); } catch (e) { console.log('groq stt failed', e.message); }
  }
  if (openai) return whisper('https://api.openai.com/v1/audio/transcriptions', openai, 'gpt-4o-transcribe', buf, mime, name);
  throw new Error('no stt');
}

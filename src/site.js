// Reads the live site as plain text for the voice agent (cached for a minute).
const BASE = process.env.SITE_URL || 'https://diskret-tanzbar.de';
let cache = { at: 0, text: '' };

const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<(br|\/p|\/h\d|\/li|\/section|\/header|\/footer|\/div)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;|&ndash;/g, '–').replace(/&[a-z]+;/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'tanzbar-studio' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export async function readSite() {
  if (Date.now() - cache.at < 60_000 && cache.text) return cache.text;
  const [html, js] = await Promise.all([get('/'), get('/assets/mm.js').catch(() => '')]);
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const sets = [...js.matchAll(/title:\s*'([^']+)'[^}]*?genre:\s*'([^']*)'[^}]*?min:\s*(\d+)/g)].map((m) => `${m[1]}${m[2] ? ` (${m[2]})` : ''}, ${m[3]} Minuten`);
  const variants = (js.match(/VARIANTS\s*=\s*\[([^\]]+)\]/) || [])[1]?.replace(/'/g, '') || '';
  const text = [
    `Seitentitel: ${title}`,
    `Sichtbarer Text der Startseite:\n${strip(html).slice(0, 3500)}`,
    sets.length ? `Sets (eingebettete SoundCloud-Player, laden erst nach Klick): ${sets.join(' | ')}` : '',
    variants ? `Zehn Design-Varianten unter /varianten/: ${variants}. Die Startseite nutzt die Variante, die auf der Übersicht als LIVE markiert ist.` : '',
    'Kontakt: Booking per Instagram-Direktnachricht an @_michael_mirage. Footer: Instagram, SoundCloud, Datenschutz.',
  ].filter(Boolean).join('\n\n');
  cache = { at: Date.now(), text };
  return text;
}

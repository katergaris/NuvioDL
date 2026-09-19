// src/extractor.js
//
// Risolve i link `externalUrl` degli addon Stremio di tipo "scraper" (es. Toastflix)
// nel vero URL dello stream (.m3u8 / .mp4), replicando lato server la logica
// dell'extractor — senza browser e senza il proxy locale di Stremio (127.0.0.1:11470),
// che l'extractor originale usa solo per ragioni CORS/mixed-content lato WebView.
//
// Un `externalUrl` punta a una pagina HTML che contiene nel <head>:
//   window.EXTRACTOR_PARAMS = { ...parametri specifici del provider... };
// e il provider è l'ultimo segmento del path (css, dd, gx, sp3, voe, ...).

const FETCH_TIMEOUT_MS = 15000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: '*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
};

function makeError(message, status = 502) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function fetchText(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { ...BASE_HEADERS, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, url: res.url };
  } catch (e) {
    if (e.name === 'AbortError') throw makeError(`Timeout nel contattare lo stream (${url})`);
    throw makeError(`Impossibile contattare lo stream (${url}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function providerFromUrl(externalUrl) {
  try {
    const pathname = new URL(externalUrl).pathname;
    const parts = pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch {
    return '';
  }
}

async function parseParams(externalUrl) {
  const res = await fetchText(externalUrl);
  if (!res.ok) throw makeError(`Extractor non raggiungibile (HTTP ${res.status})`);
  const m = res.text.match(/window\.EXTRACTOR_PARAMS\s*=\s*(\{[\s\S]*?\})\s*;?/);
  if (!m) throw makeError('Parametri extractor non trovati nella pagina');
  try {
    return JSON.parse(m[1]);
  } catch {
    throw makeError('Parametri extractor non validi');
  }
}

// ---------------------------------------------------------------
// css — StreamingCommunity / vixsrc.to
// ---------------------------------------------------------------
async function extractSc(p) {
  const isSeries = p.type === 'series';
  const apiPath = isSeries
    ? `/api/tv/${p.id}/${p.season}/${p.episode}?lang=it`
    : `/api/movie/${p.id}?lang=it`;

  const r1 = await fetchText(`https://vixsrc.to${apiPath}`, { Referer: 'https://vixsrc.to/' });
  if (!r1.ok) throw makeError(`SC: API vixsrc status ${r1.status}`);

  let data;
  try { data = JSON.parse(r1.text); } catch { throw makeError('SC: risposta API non JSON'); }
  const embedPath = String(data.src || '').replace(/\\/g, '');
  if (!embedPath) throw makeError('SC: embed path mancante');

  const r2 = await fetchText(`https://vixsrc.to${embedPath}`, { Referer: 'https://vixsrc.to/' });
  if (!r2.ok) throw makeError(`SC: embed status ${r2.status}`);
  const html = r2.text;

  let tokenV = null;
  let expiresV = null;
  let urlV = null;
  let fhdV = false;

  const mp = html.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?params\s*:\s*\{([\s\S]*?)\}\s*,\s*url\s*:\s*['"]([^'"]+)['"]/);
  if (mp) {
    urlV = mp[2].replace(/\\/g, '');
    const tM = mp[1].match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
    const eM = mp[1].match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
    if (tM) tokenV = tM[1];
    if (eM) expiresV = eM[1];
  }
  if (!tokenV) {
    const t = html.match(/'token'\s*:\s*'([^']+)'/) || html.match(/"token"\s*:\s*"([^"]+)"/);
    if (t) tokenV = t[1];
  }
  if (!expiresV) {
    const e = html.match(/'expires'\s*:\s*'([^']+)'/) || html.match(/"expires"\s*:\s*"([^"]+)"/);
    if (e) expiresV = e[1];
  }
  if (!urlV) {
    const u = html.match(/url\s*:\s*'([^']+)'/) || html.match(/url\s*:\s*"([^"]+)"/);
    if (u) urlV = u[1].replace(/\\/g, '');
  }

  const fhdMatch = html.match(/window\.canPlayFHD\s*=\s*(true|false)/);
  fhdV = fhdMatch ? fhdMatch[1] === 'true' : false;

  if (!urlV) throw makeError('SC: playlist url non trovata');
  if (!tokenV || !expiresV) throw makeError('SC: token/expires mancanti');

  const query = `token=${tokenV}&expires=${expiresV}${fhdV ? '&h=1' : ''}`;
  let playlistUrl = urlV.includes('?') ? `${urlV}&${query}` : `${urlV}?${query}`;
  playlistUrl = playlistUrl.replace('?', '.m3u8?');

  return {
    sourceUrl: playlistUrl,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      Referer: 'https://vixsrc.to/',
      Origin: 'https://vixsrc.to',
    },
  };
}

// ---------------------------------------------------------------
// dd — Altadefinizione / altadefinizionestreaming.net
// ---------------------------------------------------------------
async function extractAdn(p) {
  const isMovie = p.type === 'movie';
  const s = parseInt(p.season, 10) || 1;
  const e = parseInt(p.episode, 10) || 1;
  const BASE = 'https://altadefinizionestreaming.net';
  const endpoint = isMovie
    ? `${BASE}/api/player-sources/movie/${p.tmdb_id}`
    : `${BASE}/api/player-sources/tv/${p.tmdb_id}/${s}/${e}`;

  const fallbackCookie = 'sid=4b576705af28c1e7a4582f036704874523870520d22890fec90222263d54bdb9';
  let cookie = p.cookie;
  if (!cookie || cookie.includes('63eb86ff') || cookie.includes('1bbad4f7') || cookie.includes('32234dfa')) {
    cookie = fallbackCookie;
  }

  const r = await fetchText(endpoint, {
    Referer: `${BASE}/`,
    Accept: 'application/json,text/plain,*/*',
    Cookie: cookie,
  });
  if (!r.ok) throw makeError(`ADN: API status ${r.status}`);

  let payload;
  try { payload = JSON.parse(r.text); } catch { throw makeError('ADN: risposta non JSON'); }
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const cdn = sources.find(x => String(x.provider || '').toLowerCase() === 'cdn' && x.url);
  if (!cdn || !cdn.url) throw makeError('ADN: sorgente CDN non trovata');

  return {
    sourceUrl: String(cdn.url),
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/`,
    },
  };
}

// ---------------------------------------------------------------
// P.A.C.K.E.R. decoder + helper comuni a mixdrop/streamhg
// ---------------------------------------------------------------
function unpackPackedJs(packed) {
  let m = packed.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+|\[\])\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\(['"]\|['"]\)/);
  if (!m) {
    m = packed.match(/\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+|\[\])\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\(['"]\|['"]\)/);
  }
  if (!m) return null;

  const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const a = m[2] === '[]' ? 62 : parseInt(m[2], 10);
  const c = parseInt(m[3], 10);
  const k = m[4].split('|');

  const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function toBaseN(n) {
    if (n < a) return ALPHA[n];
    return toBaseN(Math.floor(n / a)) + ALPHA[n % a];
  }
  const dict = {};
  for (let i = 0; i < c; i++) {
    const key = toBaseN(i);
    dict[key] = (k[i] && k[i].length) ? k[i] : key;
  }
  return p.replace(/\b(\w+)\b/g, (_, w) => (dict[w] !== undefined ? dict[w] : w));
}

function unpackAll(html) {
  let combined = html;
  const packerBlocks = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\([\s\S]*?\.split\(['"]\|['"]\)[\s\S]*?\)\s*\)/g) || [];
  for (const block of packerBlocks) {
    const u = unpackPackedJs(block);
    if (u) combined += '\n' + u;
  }
  return combined;
}

function normalizeHost(h) {
  if (!h) return null;
  h = String(h).replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
  return h && /^[a-z0-9.-]+$/i.test(h) ? h : null;
}

function hostCandidates(preferred, fallbackHosts) {
  const out = [];
  const seen = new Set();
  const push = h => {
    const n = normalizeHost(h);
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  };
  push(preferred);
  for (const h of fallbackHosts) push(h);
  return out;
}

// ---------------------------------------------------------------
// gx — MixDrop / miixdrop.net
// ---------------------------------------------------------------
const MD_HOSTS = [
  'miixdrop.net', 'm1xdrop.net', 'mxdrop.net',
  'mixdrop.ag', 'mixdrop.co', 'mixdrop.sb', 'mixdrop.is',
  'mixdrop.club', 'mixdrop.to', 'mixdrop.vip',
  'm1xdrop.bz', 'mixdrop.ch', 'mixdrop.ps',
];

const MD_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

const MD_URL_PATTERNS = [
  /(?:MDCore|vsConfig)\.wurl\s*=\s*["']([^"']+)["']/,
  /wurl\s*[:=]\s*["']([^"']+)["']/,
  /<source\s+[^>]*src=["']([^"']+)["']/i,
  /file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/,
  /["'](https?:\/\/[^\s"']+\.(?:mp4|m3u8)[^\s"']*)["']/,
  /["'](\/\/[^\s"']+\.(?:mp4|m3u8)[^\s"']*)["']/,
];

function extractMdStream(text) {
  for (const re of MD_URL_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      let u = m[1].trim();
      if (u.startsWith('//')) u = 'https:' + u;
      return u;
    }
  }
  return null;
}

async function extractMd(p) {
  const hosts = hostCandidates(p.md_host, MD_HOSTS);
  let lastErr = null;
  for (const host of hosts) {
    const origin = `https://${host}`;
    let r;
    try {
      r = await fetchText(`${origin}/e/${p.md_id}`, MD_HEADERS);
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    if (!r.ok || r.text.length < 1000) {
      lastErr = `bad response status=${r.status} len=${r.text.length}`;
      continue;
    }
    const streamUrl = extractMdStream(unpackAll(r.text));
    if (!streamUrl) {
      lastErr = `stream url not found len=${r.text.length}`;
      continue;
    }
    return {
      sourceUrl: streamUrl,
      headers: { ...MD_HEADERS, Referer: `${origin}/` },
    };
  }
  throw makeError(`MixDrop: nessun host valido (${lastErr || 'host esauriti'})`);
}

// ---------------------------------------------------------------
// sp3 — StreamHG / dhcplay.com / vibuxer.com
// ---------------------------------------------------------------
const SHG_HOSTS = ['vibuxer.com', 'dhcplay.com', 'streamhg.com', 'sthg.cc', 'hgplay.com'];

const SHG_URL_PATTERNS = [
  /["']hls2["']\s*:\s*["']([^"']+)["']/i,
  /["']hls4["']\s*:\s*["']([^"']+)["']/i,
  /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
  /["'](https?:\/\/[^\s"']+\.m3u8[^\s"']*)["']/i,
];

function extractShgStream(text, pageUrl) {
  for (const re of SHG_URL_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) return new URL(m[1].replace(/\\/g, ''), pageUrl).toString();
  }
  return null;
}

async function extractShg(p) {
  const hosts = hostCandidates(p.shg_host, SHG_HOSTS);
  let lastErr = null;
  for (const host of hosts) {
    const origin = `https://${host}`;
    const pageUrl = `${origin}/e/${p.shg_id}`;
    let r;
    try {
      r = await fetchText(pageUrl, MD_HEADERS);
    } catch (e) {
      lastErr = e.message;
      continue;
    }
    if (!r.ok || r.text.length < 1000) {
      lastErr = `bad response status=${r.status} len=${r.text.length}`;
      continue;
    }
    const streamUrl = extractShgStream(unpackAll(r.text), pageUrl);
    if (!streamUrl) {
      lastErr = `stream url not found len=${r.text.length}`;
      continue;
    }
    return {
      sourceUrl: streamUrl,
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Referer: `${origin}/`,
      },
    };
  }
  throw makeError(`StreamHG: nessun host valido (${lastErr || 'host esauriti'})`);
}

// ---------------------------------------------------------------
// voe — Toonitalia VOE / chuckle-tube
// ---------------------------------------------------------------
function decodeUrlSafeB64(value) {
  let s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    return c;
  });
}

function safeB64(s) {
  s = String(s).trim();
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return Buffer.from(s, 'base64').toString('utf8');
}

function shiftChars(s, shift) {
  let res = [];
  for (let i = 0; i < s.length; i++) res.push(String.fromCharCode(s.charCodeAt(i) - shift));
  return res.join('');
}

function voeDecodeSource(obf) {
  const step1 = rot13(obf);
  let step2 = step1;
  for (const pat of ['^^', '!!', '%?', '~@', '*~', '@$', '#&']) step2 = step2.split(pat).join('');
  const step3 = safeB64(step2);
  const step4 = shiftChars(step3, 3);
  const step5 = step4.split('').reverse().join('');
  const step6 = safeB64(step5);
  const data = JSON.parse(step6);
  return data.source || data.direct_access_url || data.file || null;
}

async function extractVoe(p) {
  let embedUrl = decodeUrlSafeB64(p.u).trim().replace('chuckle-tube.com', 'eugenemakedraw.com');
  let current = embedUrl;
  let finalOrigin;
  try { finalOrigin = new URL(current).origin; } catch {}

  let r = await fetchText(current, { 'User-Agent': UA });
  let html = r.text;

  // Eventuale redirect JS nella pagina di atterraggio
  const redirMatch = html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
  if (redirMatch) {
    const nextUrl = new URL(redirMatch[1], current).href;
    current = nextUrl;
    try { finalOrigin = new URL(current).origin; } catch {}
    const r2 = await fetchText(current, { 'User-Agent': UA, Referer: embedUrl });
    html = r2.text;
  }

  let streamUrl = null;

  // Method 8 — <script type="application/json">
  const jsonMatches = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const jStr of jsonMatches) {
    try {
      const cleanJson = jStr.replace(/<\/?script[^>]*>/g, '').trim();
      const arr = JSON.parse(cleanJson);
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'string') {
        const s = voeDecodeSource(arr[0]);
        if (s && s.startsWith('http')) {
          streamUrl = s;
          break;
        }
      }
    } catch {}
  }

  // Method 7 — MKGMa
  if (!streamUrl) {
    const mkgmaMatch = html.match(/MKGMa="([^"]+)"/);
    if (mkgmaMatch) {
      try {
        const s = voeDecodeSource(mkgmaMatch[1].split('_').join(''));
        if (s && s.startsWith('http')) streamUrl = s;
      } catch {}
    }
  }

  // Fallback — regex .m3u8 / source
  if (!streamUrl) {
    const mHls = html.match(/hls["']?\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (mHls) streamUrl = mHls[1];
  }
  if (!streamUrl) {
    const mSrc = html.match(/var\s+source\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
    if (mSrc && !mSrc[1].includes('test-videos.co.uk')) streamUrl = mSrc[1];
  }

  if (!streamUrl) throw makeError('Stream VOE non trovato nella pagina');

  // Master playlist -> variante diretta (più stabile per il remux)
  if (streamUrl.includes('/master.m3u8')) {
    streamUrl = streamUrl.replace('/master.m3u8', '/index-v1-a1.m3u8');
  }

  return {
    sourceUrl: streamUrl,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      Referer: current,
      Origin: finalOrigin || undefined,
    },
  };
}

// ---------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------
const EXTRACTORS = {
  css: extractSc,
  dd: extractAdn,
  gx: extractMd,
  sp3: extractShg,
  voe: extractVoe,
};

async function resolveExternalUrl(externalUrl) {
  const provider = providerFromUrl(externalUrl);
  const p = await parseParams(externalUrl);
  const fn = EXTRACTORS[provider];
  if (!fn) throw makeError(`Provider extractor non supportato: ${provider}`, 501);
  return fn(p);
}

module.exports = { resolveExternalUrl, providerFromUrl };

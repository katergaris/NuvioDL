const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const config = require('./config');

const FIRST_BYTE_TIMEOUT_MS = 30000;
const STALL_TIMEOUT_MS = 30000;

let active = 0;

function sanitizeFilename(name) {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    .replace(/[/\\?%*:|"<>\x00-\x1F]/g, '')
    .replace(/\.\.+/g, '.')
    .trim();
  return cleaned.slice(0, 180).trim() || 'file';
}

function detectType(url) {
  const clean = url.split('?')[0].split('#')[0];
  return /\.m3u8$/i.test(clean) ? 'hls' : 'direct';
}

function guessExtension(url) {
  const clean = url.split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase();
  const known = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.ts'];
  return known.includes(ext) ? ext : '.mp4';
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  const utf8 = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function prepareDownload({ sourceUrl, headers, title, streamTitle }) {
  if (!sourceUrl || /^magnet:/i.test(sourceUrl)) {
    const err = new Error('Stream non supportato: nessun URL diretto disponibile (solo infoHash/torrent)');
    err.status = 400;
    throw err;
  }
  const type = detectType(sourceUrl);
  const ext = type === 'hls' ? '.mkv' : guessExtension(sourceUrl);
  const baseName = sanitizeFilename(title || streamTitle || 'download');
  return { sourceUrl, headers: headers || null, filename: `${baseName}${ext}`, type };
}

async function streamDownload({ sourceUrl, headers, filename, type }, res) {
  if (active >= (config.get().concurrentDownloads || 1)) {
    res.status(429).json({ error: 'Troppi download in corso, riprova tra poco' });
    return;
  }
  active++;
  try {
    if (type === 'hls') {
      await streamHls(sourceUrl, headers, filename, res);
    } else {
      await streamDirect(sourceUrl, headers, filename, res);
    }
  } finally {
    active--;
  }
}

async function streamDirect(sourceUrl, headers, filename, res) {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(sourceUrl, { headers: headers || {}, signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutTimer);
    const message = e.name === 'AbortError'
      ? `Timeout: lo stream non ha risposto entro ${FIRST_BYTE_TIMEOUT_MS / 1000}s`
      : `Impossibile contattare lo stream: ${e.message}`;
    res.status(502).json({ error: message });
    return;
  }
  clearTimeout(timeoutTimer);

  if (upstream.status === 403) {
    // Alcuni CDN legano l'URL firmato all'IP/contesto di chi lo ha generato (il device
    // dove gira Nuvio): il nostro server, scaricando da un IP diverso, viene rifiutato
    // anche con gli stessi header. Come fallback, reindirizziamo il browser a scaricare
    // direttamente dalla fonte: perdiamo il controllo su Content-Disposition/header
    // custom, ma l'IP torna a combaciare con quello atteso dal CDN.
    res.redirect(302, sourceUrl);
    return;
  }

  if (!upstream.ok) {
    res.status(502).json({ error: `Il server dello stream ha risposto ${upstream.status} ${upstream.statusText}` });
    return;
  }

  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);

  const nodeStream = Readable.fromWeb(upstream.body);
  res.on('close', () => {
    if (!res.writableEnded) nodeStream.destroy();
  });

  try {
    await pipeline(nodeStream, res);
  } catch {
    // client disconnected mid-transfer, nothing more to do
  }
}

let ffmpegOk = null;
function ffmpegAvailable() {
  if (ffmpegOk === null) {
    ffmpegOk = !spawnSync('ffmpeg', ['-version']).error;
  }
  return ffmpegOk;
}

// Remux HLS -> MKV in streaming: l'output di ffmpeg viene inoltrato al client man mano
// che viene prodotto, invece di bufferizzare l'intero file su disco prima di rispondere.
// È necessario perché il download nativo di Nuvio (e diversi browser) abbandona se non
// riceve il primo byte entro pochi secondi: con un remux "buffer-first" l'intero contenuto
// restava in attesa per minuti e il download non partiva mai.
async function streamHls(sourceUrl, headers, filename, res) {
  if (!ffmpegAvailable()) {
    res.status(500).json({ error: 'ffmpeg non è installato o non è nel PATH' });
    return;
  }

  const args = ['-y'];
  if (headers && Object.keys(headers).length) {
    const headerStr = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n';
    args.push('-headers', headerStr);
  }
  args.push(
    '-i', sourceUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    // L'audio viene ricodificato (non copiato) perché diversi stream HLS (es. css /
    // StreamingCommunity) hanno extradata AAC malformato: con "-c:a copy" ffmpeg fallisce
    // con "Error parsing AAC extradata, unable to determine samplerate" e non produce nulla.
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'matroska',
    '-flush_packets', '1',
    'pipe:1'
  );

  const ff = spawn('ffmpeg', args);

  // Manda subito gli header: da qui in poi il client vede un download "attivo" con
  // progresso reale invece di restare appeso in attesa del remux completo.
  res.setHeader('Content-Type', 'video/x-matroska');
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.flushHeaders();

  let bytes = 0;
  let lastSize = 0;
  let stalledSince = Date.now();
  const stallCheck = setInterval(() => {
    if (bytes > lastSize) {
      lastSize = bytes;
      stalledSince = Date.now();
    } else if (Date.now() - stalledSince > STALL_TIMEOUT_MS) {
      ff.kill('SIGKILL');
    }
  }, 2000);

  const onClientAbort = () => ff.kill('SIGKILL');
  res.on('close', onClientAbort);
  res.on('error', () => {}); // assorbe errori di scrittura dopo la disconnessione del client

  ff.stderr.on('data', () => {}); // consuma il log per non riempire il buffer di stderr

  ff.stdout.on('data', chunk => { bytes += chunk.length; });
  ff.stdout.pipe(res);

  await new Promise(resolve => {
    ff.on('error', resolve);
    ff.on('close', resolve);
  });

  clearInterval(stallCheck);
  res.removeListener('close', onClientAbort);
  if (!res.writableEnded) res.end();
}

module.exports = { prepareDownload, streamDownload, sanitizeFilename, detectType, guessExtension };

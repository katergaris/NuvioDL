const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const config = require('./config');

const FIRST_BYTE_TIMEOUT_MS = 30000;

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

function streamHls(sourceUrl, headers, filename, res) {
  return new Promise(resolve => {
    const args = ['-y'];
    if (headers && Object.keys(headers).length) {
      const headerStr = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n';
      args.push('-headers', headerStr);
    }
    args.push(
      '-i', sourceUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-f', 'matroska', 'pipe:1'
    );

    let ff;
    try {
      ff = spawn('ffmpeg', args);
    } catch {
      res.status(500).json({ error: 'ffmpeg non è installato o non è nel PATH' });
      return resolve();
    }

    let settled = false;
    let stderrTail = [];

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (!res.headersSent) res.status(status).json({ error: message });
      else res.end();
      ff.kill('SIGKILL');
      resolve();
    };

    const timeoutTimer = setTimeout(() => {
      const tail = stderrTail.slice(-6).join(' ').slice(0, 300);
      const suffix = tail ? ` — ultimo log ffmpeg: ${tail}` : ' (ffmpeg non ha ancora prodotto alcun log)';
      fail(504, `Timeout: nessun dato ricevuto dallo stream entro ${FIRST_BYTE_TIMEOUT_MS / 1000}s (sorgente lenta, irraggiungibile o che richiede autenticazione non gestita)${suffix}`);
    }, FIRST_BYTE_TIMEOUT_MS);

    ff.on('error', err => {
      fail(500, err.code === 'ENOENT' ? 'ffmpeg non è installato o non è nel PATH' : err.message);
    });

    ff.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrTail.push(...text.split('\n').filter(Boolean));
      if (stderrTail.length > 40) stderrTail = stderrTail.slice(-40);
    });

    ff.stdout.once('data', firstChunk => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      res.setHeader('Content-Disposition', contentDisposition(filename));
      res.setHeader('Content-Type', 'video/x-matroska');
      res.write(firstChunk);
      ff.stdout.pipe(res);
    });

    ff.on('close', code => {
      if (settled) {
        resolve();
        return;
      }
      clearTimeout(timeoutTimer);
      if (code === 0) {
        fail(502, 'ffmpeg non ha prodotto alcun output');
      } else {
        const tail = stderrTail.slice(-8).join(' ').slice(0, 400);
        fail(502, `ffmpeg terminato con codice ${code}: ${tail || 'errore sconosciuto'}`);
      }
    });

    res.on('close', () => {
      clearTimeout(timeoutTimer);
      if (!res.writableEnded) ff.kill('SIGKILL');
    });
  });
}

module.exports = { prepareDownload, streamDownload, sanitizeFilename };

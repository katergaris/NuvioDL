const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const config = require('./config');

const FIRST_BYTE_TIMEOUT_MS = 30000;
const STALL_TIMEOUT_MS = 30000;
const MIN_SUCCESS_BYTES = 256 * 1024;

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

async function cleanupFile(filePath) {
  await fs.promises.unlink(filePath).catch(() => {});
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

// Scrivere l'output remuxato di ffmpeg direttamente su pipe:1 (stdout) e inoltrarlo in
// streaming produceva in certi ambienti solo l'intestazione del contenitore (poche
// centinaia di byte) e poi si interrompeva, anche quando la stessa identica sorgente
// scaricata scrivendo su un file reale funzionava perfettamente. Per questo ffmpeg scrive
// qui su un file temporaneo (come nella versione che funzionava), e solo a remux completo
// il file viene inoltrato al client — cancellato subito dopo, quindi non si accumula mai
// nulla in modo permanente sulla RPi.
async function streamHls(sourceUrl, headers, filename, res) {
  const tempPath = path.join(os.tmpdir(), `nuvio-offline-${crypto.randomUUID()}.mkv`);
  const args = ['-y'];
  if (headers && Object.keys(headers).length) {
    const headerStr = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n';
    args.push('-headers', headerStr);
  }
  args.push('-i', sourceUrl, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', tempPath);

  let ff;
  try {
    ff = spawn('ffmpeg', args);
  } catch {
    res.status(500).json({ error: 'ffmpeg non è installato o non è nel PATH' });
    return;
  }

  let stderrTail = [];
  ff.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderrTail.push(...text.split('\n').filter(Boolean));
    if (stderrTail.length > 40) stderrTail = stderrTail.slice(-40);
  });

  let lastSize = 0;
  let stalledSince = Date.now();
  let stalled = false;
  const stallCheck = setInterval(() => {
    const size = fileSize(tempPath);
    if (size > lastSize) {
      lastSize = size;
      stalledSince = Date.now();
    } else if (Date.now() - stalledSince > STALL_TIMEOUT_MS) {
      stalled = true;
      ff.kill('SIGKILL');
    }
  }, 2000);

  const onClientAbort = () => ff.kill('SIGKILL');
  res.on('close', onClientAbort);

  let spawnError = null;
  const exitCode = await new Promise(resolve => {
    ff.on('error', err => {
      spawnError = err;
      resolve(null);
    });
    ff.on('close', code => resolve(code));
  });

  clearInterval(stallCheck);
  res.removeListener('close', onClientAbort);

  if (spawnError) {
    await cleanupFile(tempPath);
    if (!res.headersSent) {
      res.status(500).json({
        error: spawnError.code === 'ENOENT' ? 'ffmpeg non è installato o non è nel PATH' : spawnError.message
      });
    }
    return;
  }

  const finalSize = fileSize(tempPath);

  if (finalSize < MIN_SUCCESS_BYTES) {
    await cleanupFile(tempPath);
    if (res.headersSent || res.writableEnded) return;
    if (stalled) {
      res.status(504).json({
        error: `Timeout: il download si è bloccato, nessun progresso da ${STALL_TIMEOUT_MS / 1000}s (${finalSize} byte scaricati prima dello stallo)`
      });
    } else if (exitCode === 0) {
      res.status(502).json({
        error: `Lo stream si è interrotto dopo soli ${finalSize} byte (fonte vuota, sessione scaduta o non compatibile con un accesso diretto)`
      });
    } else {
      const tail = stderrTail.slice(-8).join(' ').slice(0, 400);
      res.status(502).json({ error: `ffmpeg terminato con codice ${exitCode}: ${tail || 'errore sconosciuto'}` });
    }
    return;
  }

  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('Content-Type', 'video/x-matroska');
  res.setHeader('Content-Length', finalSize);

  try {
    await pipeline(fs.createReadStream(tempPath), res);
  } catch {
    // client disconnesso durante l'invio del file, nessun problema
  } finally {
    await cleanupFile(tempPath);
  }
}

module.exports = { prepareDownload, streamDownload, sanitizeFilename, detectType, guessExtension };

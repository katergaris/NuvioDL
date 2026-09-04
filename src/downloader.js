const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

let config = null;
let queueFilePath = null;
let jobs = [];
const activeControllers = new Map();
let dirty = false;
let started = false;

function sanitizeFilename(name) {
  const cleaned = String(name || 'file')
    .normalize('NFKD')
    .replace(/[/\\?%*:|"<>\x00-\x1F]/g, '')
    .replace(/\.\.+/g, '.')
    .trim();
  const trimmed = cleaned.slice(0, 180).trim() || 'file';
  return trimmed;
}

function uniqueFilename(downloadsPath, baseName, ext) {
  let candidate = `${baseName}${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(downloadsPath, candidate))) {
    candidate = `${baseName} (${i})${ext}`;
    i++;
  }
  return candidate;
}

function detectType(url) {
  const clean = url.split('?')[0].split('#')[0];
  if (/\.m3u8$/i.test(clean)) return 'hls';
  return 'direct';
}

function guessExtension(url) {
  const clean = url.split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase();
  const known = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.ts'];
  return known.includes(ext) ? ext : '.mp4';
}

function markDirty() {
  dirty = true;
}

function persist() {
  const serializable = jobs.map(({ _stderrTail, ...j }) => j);
  fs.writeFileSync(queueFilePath, JSON.stringify(serializable, null, 2));
  dirty = false;
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function init(cfg) {
  if (started) return;
  started = true;
  config = cfg;
  queueFilePath = path.join(config.dataPath, 'queue.json');

  if (fs.existsSync(queueFilePath)) {
    try {
      jobs = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
    } catch {
      jobs = [];
    }
  }
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'downloading') {
      job.status = 'queued';
      job.progress = job.progress || null;
      touch(job);
      changed = true;
    }
  }
  if (changed) persist();

  setInterval(() => {
    if (dirty) persist();
  }, 2000).unref();

  processQueue();
}

function list() {
  return jobs.map(({ _stderrTail, ...j }) => j);
}

function enqueue(input) {
  const { addonName, sourceUrl, infoHash, headers, title, mediaType, streamTitle } = input;

  if (!sourceUrl || /^magnet:/i.test(sourceUrl)) {
    const err = new Error('Stream non supportato: nessun URL diretto disponibile (solo infoHash/torrent)');
    err.status = 400;
    throw err;
  }

  const type = detectType(sourceUrl);
  const ext = type === 'hls' ? '.mkv' : guessExtension(sourceUrl);
  const baseName = sanitizeFilename(title || streamTitle || 'download');
  const filename = uniqueFilename(config.downloadsPath, baseName, ext);

  const job = {
    id: crypto.randomUUID(),
    title: title || baseName,
    mediaType: mediaType || null,
    addonName: addonName || null,
    streamTitle: streamTitle || null,
    sourceUrl,
    infoHash: infoHash || null,
    headers: headers || null,
    type,
    filename,
    status: 'queued',
    progress: null,
    downloadedBytes: null,
    totalBytes: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  jobs.push(job);
  persist();
  processQueue();
  return { ...job };
}

function remove(id) {
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return false;
  const job = jobs[idx];

  const controller = activeControllers.get(id);
  if (controller) {
    controller.cancel();
    activeControllers.delete(id);
  }

  jobs.splice(idx, 1);
  persist();

  if (job.status !== 'done') {
    const filePath = path.join(config.downloadsPath, job.filename);
    fs.promises.unlink(filePath).catch(() => {});
  }

  processQueue();
  return true;
}

function countActive() {
  return jobs.filter(j => j.status === 'downloading').length;
}

function processQueue() {
  while (countActive() < (config.concurrentDownloads || 1)) {
    const next = jobs.find(j => j.status === 'queued');
    if (!next) break;
    startJob(next);
  }
}

function startJob(job) {
  job.status = 'downloading';
  job.error = null;
  touch(job);
  persist();

  const outputPath = path.join(config.downloadsPath, job.filename);
  const finish = job.type === 'hls' ? runHls : runDirect;

  finish(job, outputPath)
    .then(() => {
      job.status = 'done';
      job.progress = 100;
      try {
        job.totalBytes = fs.statSync(outputPath).size;
        job.downloadedBytes = job.totalBytes;
      } catch {}
      touch(job);
      persist();
    })
    .catch(err => {
      job.status = 'error';
      job.error = err.message || String(err);
      touch(job);
      persist();
    })
    .finally(() => {
      activeControllers.delete(job.id);
      processQueue();
    });
}

function parseDurationSeconds(text) {
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function parseOutTimeSeconds(line) {
  const m = line.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function runHls(job, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-y'];
    if (job.headers && Object.keys(job.headers).length) {
      const headerStr = Object.entries(job.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n';
      args.push('-headers', headerStr);
    }
    args.push('-i', job.sourceUrl, '-c', 'copy', '-progress', 'pipe:1', '-nostats', outputPath);

    let ff;
    try {
      ff = spawn('ffmpeg', args);
    } catch (e) {
      return reject(new Error('ffmpeg non è installato o non è nel PATH'));
    }

    activeControllers.set(job.id, { cancel: () => ff.kill('SIGKILL') });

    let durationSeconds = null;
    let stderrTail = [];
    let stdoutBuf = '';

    ff.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg non è installato o non è nel PATH'));
      } else {
        reject(err);
      }
    });

    ff.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (durationSeconds === null) {
        const d = parseDurationSeconds(text);
        if (d !== null) durationSeconds = d;
      }
      stderrTail.push(...text.split('\n').filter(Boolean));
      if (stderrTail.length > 30) stderrTail = stderrTail.slice(-30);
    });

    ff.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('out_time=')) {
          const elapsed = parseOutTimeSeconds(line);
          if (elapsed !== null) {
            job.downloadedBytes = null;
            if (durationSeconds) {
              job.progress = Math.min(100, Math.round((elapsed / durationSeconds) * 1000) / 10);
            }
            markDirty();
          }
        }
      }
    });

    ff.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrTail.slice(-8).join(' ').slice(0, 400);
        reject(new Error(`ffmpeg terminato con codice ${code}: ${tail || 'errore sconosciuto'}`));
      }
    });
  });
}

async function runDirect(job, outputPath) {
  const controller = new AbortController();
  activeControllers.set(job.id, { cancel: () => controller.abort() });

  let res;
  try {
    res = await fetch(job.sourceUrl, { headers: job.headers || {}, signal: controller.signal });
  } catch (e) {
    throw new Error(`Impossibile scaricare lo stream: ${e.message}`);
  }

  if (!res.ok) {
    throw new Error(`Il server ha risposto ${res.status} ${res.statusText}`);
  }

  const totalHeader = res.headers.get('content-length');
  job.totalBytes = totalHeader ? Number(totalHeader) : null;
  job.downloadedBytes = 0;

  const outStream = fs.createWriteStream(outputPath);
  const nodeStream = Readable.fromWeb(res.body);

  nodeStream.on('data', chunk => {
    job.downloadedBytes += chunk.length;
    job.progress = job.totalBytes ? Math.min(100, Math.round((job.downloadedBytes / job.totalBytes) * 1000) / 10) : null;
    markDirty();
  });

  try {
    await pipeline(nodeStream, outStream);
  } catch (e) {
    throw new Error(`Download interrotto: ${e.message}`);
  }
}

module.exports = { init, list, enqueue, remove, sanitizeFilename };

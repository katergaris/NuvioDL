const express = require('express');
const path = require('path');

const config = require('./src/config');
const addons = require('./src/addons');
const streamer = require('./src/streamer');

const cfg = config.get();

const app = express();

app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(express.json());

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---- Search / TMDB ----

app.get('/api/search', asyncRoute(async (req, res) => {
  const { query } = req.query;
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: 'Parametro query mancante' });
  }
  const results = await addons.searchMulti(String(query).trim(), cfg.tmdbApiKey, cfg.language);
  res.json({ results });
}));

app.get('/api/seasons/:tmdbId', asyncRoute(async (req, res) => {
  const seasons = await addons.getSeasons(req.params.tmdbId, cfg.tmdbApiKey, cfg.language);
  res.json({ seasons });
}));

app.get('/api/episodes/:tmdbId/:season', asyncRoute(async (req, res) => {
  const episodes = await addons.getEpisodes(req.params.tmdbId, req.params.season, cfg.tmdbApiKey, cfg.language);
  res.json({ episodes });
}));

// ---- Streams (Stremio addon protocol) ----

app.get('/api/streams', asyncRoute(async (req, res) => {
  const { tmdbId, type, season, episode } = req.query;
  if (!tmdbId || !type) {
    return res.status(400).json({ error: 'Parametri tmdbId e type richiesti' });
  }
  if (type === 'tv' && (!season || !episode)) {
    return res.status(400).json({ error: 'Parametri season ed episode richiesti per le serie' });
  }

  const stremioType = type === 'tv' ? 'series' : 'movie';
  const imdbId = await addons.getImdbId(tmdbId, type, cfg.tmdbApiKey);
  if (!imdbId) {
    return res.status(404).json({ error: 'IMDb ID non trovato per questo titolo' });
  }

  const stremioId = addons.buildStremioId(imdbId, stremioType, season, episode);
  const addonList = config.listAddons();
  if (addonList.length === 0) {
    return res.status(400).json({ error: 'Nessun addon configurato (vai nella tab Addon)' });
  }

  const { streams, errors } = await addons.getStreamsForAllAddons(addonList, stremioType, stremioId);
  res.json({ imdbId, stremioId, streams, errors });
}));

// ---- Impostazioni ----

app.get('/api/settings', (req, res) => {
  const current = config.get();
  res.json({
    tmdbApiKey: current.tmdbApiKey,
    language: current.language,
    concurrentDownloads: current.concurrentDownloads
  });
});

app.post('/api/settings', (req, res) => {
  const updated = config.updateSettings(req.body || {});
  res.json({
    tmdbApiKey: updated.tmdbApiKey,
    language: updated.language,
    concurrentDownloads: updated.concurrentDownloads
  });
});

// ---- Addons CRUD ----

app.get('/api/addons', (req, res) => {
  res.json({ addons: config.listAddons() });
});

app.post('/api/addons', (req, res) => {
  const { name, manifestUrl } = req.body || {};
  if (!name || !manifestUrl) {
    return res.status(400).json({ error: 'name e manifestUrl richiesti' });
  }
  const addon = config.addAddon({ name, manifestUrl });
  res.status(201).json({ addon });
});

app.delete('/api/addons/:id', (req, res) => {
  const removed = config.removeAddon(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Addon non trovato' });
  res.status(204).end();
});

// ---- Download (streaming diretto verso il dispositivo, nessuno storage sul server) ----

function decodeDownloadPayload(raw) {
  if (!raw) return {};
  // Formato preferito: base64url (nessun carattere speciale, sopravvive a qualunque
  // ri-codifica imperfetta lungo il tragitto browser/app -> proxy -> server).
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // Fallback per compatibilità con eventuali link vecchio formato (JSON + encodeURIComponent).
    return JSON.parse(raw);
  }
}

function encodeDownloadPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

async function handleDownload(rawData, res) {
  let params;
  try {
    params = decodeDownloadPayload(rawData);
  } catch {
    return res.status(400).json({ error: 'Parametro data non valido' });
  }

  let prepared;
  try {
    prepared = streamer.prepareDownload(params);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  await streamer.streamDownload(prepared, res);
}

// Formato con estensione nel path (es. /api/download/<dati>/Titolo.mkv): alcune app,
// incluso il download nativo di Nuvio, decidono se un link è "un file diretto scaricabile"
// guardando l'estensione nell'URL — un endpoint puramente query-string come
// /api/download?data=... non ne ha nessuna e viene scartato. Il segmento finale è solo
// cosmetico: il nome file vero per l'header Content-Disposition è ricalcolato lato server.
app.get('/api/download/:data/:filename', asyncRoute(async (req, res) => {
  await handleDownload(req.params.data, res);
}));

app.get('/api/download', asyncRoute(async (req, res) => {
  await handleDownload(req.query.data, res);
}));

// ---- Stremio/Nuvio addon (nuvio-offline installata come addon dentro Nuvio) ----
//
// Espone questo stesso server come addon: quando Nuvio interroga /stream/:type/:id.json,
// nuvio-offline ri-interroga gli addon "sorgente" configurati (stessa logica di
// /api/streams), tiene solo gli stream scaricabili e li restituisce come voci con `url`
// puntato a /api/download/... — un link che si comporta come un normale file video diretto
// (risponde con Content-Type/Content-Length/Content-Disposition validi una volta pronto),
// così il download nativo di Nuvio lo riconosce e lo scarica da solo sul device, senza
// passare dal browser esterno.

const ADDON_ID = 'org.nuvio-offline';

function addonCors(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}

function parseStremioId(id) {
  const [imdbId, season, episode] = id.split(':');
  return { imdbId, season, episode };
}

app.get('/manifest.json', addonCors, (req, res) => {
  res.json({
    id: ADDON_ID,
    version: '1.0.0',
    name: 'Nuvio Offline',
    description: 'Scarica sul dispositivo i contenuti trovati dagli addon configurati in nuvio-offline',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: false }
  });
});

app.get('/stream/:type/:id.json', addonCors, asyncRoute(async (req, res) => {
  const { type, id } = req.params;
  if (type !== 'movie' && type !== 'series') return res.json({ streams: [] });

  const addonList = config.listAddons();
  if (!addonList.length) return res.json({ streams: [] });

  const { streams } = await addons.getStreamsForAllAddons(addonList, type, id);
  const downloadable = streams.filter(s => s.supported);
  if (!downloadable.length) return res.json({ streams: [] });

  const { imdbId, season, episode } = parseStremioId(id);
  let label = id;
  try {
    const info = await addons.findByImdbId(imdbId, type, cfg.tmdbApiKey, cfg.language);
    if (info && info.title) {
      label = type === 'series'
        ? `${info.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : `${info.title}${info.year ? ` (${info.year})` : ''}`;
    }
  } catch {
    // TMDB non configurata/raggiungibile: usa l'id grezzo come titolo del file
  }

  const base = `${req.protocol}://${req.get('host')}`;
  const result = downloadable.map(s => {
    const payload = {
      addonName: s.addonName,
      sourceUrl: s.url,
      headers: s.headers,
      streamTitle: s.title,
      title: label
    };
    const streamType = streamer.detectType(s.url);
    const ext = streamType === 'hls' ? '.mkv' : streamer.guessExtension(s.url);
    const cosmeticFilename = encodeURIComponent(`${label}${ext}`);
    const downloadUrl = `${base}/api/download/${encodeDownloadPayload(payload)}/${cosmeticFilename}`;
    return {
      name: '⬇️ Scarica offline',
      title: `${s.title}\n${s.addonName}`,
      url: downloadUrl,
      behaviorHints: { filename: `${label}${ext}` }
    };
  });

  res.json({ streams: result });
}));

// ---- Static files ----

app.use(express.static(path.join(__dirname, 'public')));

// ---- Error handler ----

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.message || 'Errore interno' });
});

const httpServer = app.listen(cfg.port, () => {
  console.log(`nuvio-offline in ascolto su http://localhost:${cfg.port}`);
});

// Se il parser HTTP di Node riceve una richiesta malformata (es. un URL con byte grezzi
// non percent-encoded), la rifiuta PRIMA che arrivi alle route Express: senza questo
// listener quel rifiuto è silenzioso (nessuna riga di log), il che rende impossibile
// distinguere "la richiesta non è mai arrivata" da "il server l'ha processata e ha
// risposto qualcos'altro". Logghiamo esplicitamente e rispondiamo 400 come farebbe
// comunque Node di default.
httpServer.on('clientError', (err, socket) => {
  console.error(`CLIENT ERROR: richiesta malformata rifiutata prima di Express — ${err.message}`);
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
});

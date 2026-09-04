const express = require('express');
const path = require('path');

const config = require('./src/config');
const addons = require('./src/addons');
const downloader = require('./src/downloader');
const library = require('./src/library');

const cfg = config.get();
downloader.init(cfg);

const app = express();
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

// ---- Download queue ----

app.get('/api/queue', (req, res) => {
  res.json({ jobs: downloader.list() });
});

app.post('/api/queue', (req, res) => {
  try {
    const job = downloader.enqueue(req.body || {});
    res.status(201).json({ job });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.delete('/api/queue/:id', (req, res) => {
  const removed = downloader.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Job non trovato' });
  res.status(204).end();
});

// ---- Library ----

app.get('/api/library', (req, res) => {
  res.json({ files: library.list(cfg.downloadsPath) });
});

app.delete('/api/library/:filename', (req, res) => {
  try {
    const removed = library.remove(cfg.downloadsPath, req.params.filename);
    if (!removed) return res.status(404).json({ error: 'File non trovato' });
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Static files ----

app.use('/media', express.static(cfg.downloadsPath));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Error handler ----

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Errore interno' });
});

app.listen(cfg.port, () => {
  console.log(`nuvio-offline in ascolto su http://localhost:${cfg.port}`);
});

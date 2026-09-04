const express = require('express');
const path = require('path');

const config = require('./src/config');
const addons = require('./src/addons');
const streamer = require('./src/streamer');

const cfg = config.get();

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

// ---- Download (streaming diretto verso il dispositivo, nessuno storage sul server) ----

app.get('/api/download', asyncRoute(async (req, res) => {
  let params;
  try {
    params = JSON.parse(req.query.data || '{}');
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
}));

// ---- Static files ----

app.use(express.static(path.join(__dirname, 'public')));

// ---- Error handler ----

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.message || 'Errore interno' });
});

app.listen(cfg.port, () => {
  console.log(`nuvio-offline in ascolto su http://localhost:${cfg.port}`);
});

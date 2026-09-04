const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w200';
const FETCH_TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer, promise };
}

async function tmdbFetch(pathname, apiKey, params = {}) {
  if (!apiKey) {
    const err = new Error('TMDB API key non configurata (config.json > tmdbApiKey)');
    err.status = 400;
    throw err;
  }
  const url = new URL(TMDB_BASE + pathname);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const { controller, timer, promise: _p } = withTimeout(null, FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(`Impossibile contattare TMDB: ${e.message}`);
    err.status = 502;
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`TMDB ha risposto ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status === 401 ? 401 : 502;
    throw err;
  }
  return res.json();
}

async function searchMulti(query, apiKey, language) {
  const data = await tmdbFetch('/search/multi', apiKey, {
    query,
    language,
    include_adult: 'false'
  });
  return (data.results || [])
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .map(r => ({
      tmdbId: r.id,
      type: r.media_type,
      title: r.title || r.name || '(senza titolo)',
      originalTitle: r.original_title || r.original_name || null,
      year: (r.release_date || r.first_air_date || '').slice(0, 4) || null,
      overview: r.overview || '',
      posterUrl: r.poster_path ? IMAGE_BASE + r.poster_path : null
    }));
}

async function getImdbId(tmdbId, type, apiKey) {
  const data = await tmdbFetch(`/${type}/${tmdbId}/external_ids`, apiKey);
  return data.imdb_id || null;
}

async function getSeasons(tmdbId, apiKey, language) {
  const data = await tmdbFetch(`/tv/${tmdbId}`, apiKey, { language });
  return (data.seasons || []).map(s => ({
    seasonNumber: s.season_number,
    name: s.name,
    episodeCount: s.episode_count,
    airDate: s.air_date || null,
    posterUrl: s.poster_path ? IMAGE_BASE + s.poster_path : null
  }));
}

async function getEpisodes(tmdbId, season, apiKey, language) {
  const data = await tmdbFetch(`/tv/${tmdbId}/season/${season}`, apiKey, { language });
  return (data.episodes || []).map(e => ({
    episodeNumber: e.episode_number,
    name: e.name,
    overview: e.overview || '',
    airDate: e.air_date || null,
    stillUrl: e.still_path ? IMAGE_BASE + e.still_path : null
  }));
}

function buildStremioId(imdbId, mediaType, season, episode) {
  if (mediaType === 'series') return `${imdbId}:${season}:${episode}`;
  return imdbId;
}

function addonBaseUrl(manifestUrl) {
  return manifestUrl.trim().replace(/\/manifest\.json.*$/i, '').replace(/\/+$/, '');
}

function isSupportedStream(s) {
  return !!s.url && !/^magnet:/i.test(s.url);
}

async function queryAddonStreams(addon, stremioType, stremioId) {
  const base = addonBaseUrl(addon.manifestUrl);
  const url = `${base}/stream/${stremioType}/${encodeURIComponent(stremioId).replace(/%3A/g, ':')}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { addonId: addon.id, addonName: addon.name, error: `HTTP ${res.status}`, streams: [] };
    }
    const data = await res.json();
    const streams = (data.streams || []).map(s => ({
      addonId: addon.id,
      addonName: addon.name,
      name: s.name || null,
      title: s.title || s.description || s.name || 'Stream',
      url: s.url || null,
      infoHash: s.infoHash || null,
      headers: (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || null,
      suggestedFilename: (s.behaviorHints && s.behaviorHints.filename) || null,
      supported: isSupportedStream(s)
    }));
    return { addonId: addon.id, addonName: addon.name, error: null, streams };
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? 'timeout' : e.message;
    return { addonId: addon.id, addonName: addon.name, error: msg, streams: [] };
  }
}

async function getStreamsForAllAddons(addons, stremioType, stremioId) {
  const results = await Promise.all(
    addons.map(addon => queryAddonStreams(addon, stremioType, stremioId))
  );
  const streams = results.flatMap(r => r.streams);
  const errors = results.filter(r => r.error).map(r => ({ addonName: r.addonName, error: r.error }));
  return { streams, errors };
}

module.exports = {
  searchMulti,
  getImdbId,
  getSeasons,
  getEpisodes,
  buildStremioId,
  getStreamsForAllAddons
};

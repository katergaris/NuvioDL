const state = {
  currentItem: null,
  currentSeason: null,
  queuePollTimer: null
};

// ---- Utilities ----

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    throw new Error((data && data.error) || `Errore ${res.status}`);
  }
  return data;
}

function humanSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanDate(iso) {
  return new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---- Tabs ----

function initTabs() {
  $all('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  $all('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $all('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'queue') loadQueue();
  if (name === 'library') loadLibrary();
  if (name === 'addons') loadAddons();
}

// ---- Search ----

function initSearch() {
  $('#search-form').addEventListener('submit', async e => {
    e.preventDefault();
    const query = $('#search-input').value.trim();
    if (!query) return;
    hideDetail();
    const results = document.getElementById('search-results');
    results.innerHTML = '<div class="empty">Ricerca in corso...</div>';
    try {
      const { results: items } = await api(`/search?query=${encodeURIComponent(query)}`);
      renderResults(items);
    } catch (e) {
      results.innerHTML = '';
      toast(e.message, true);
    }
  });

  $('#detail-back').addEventListener('click', hideDetail);
}

function renderResults(items) {
  const container = $('#search-results');
  container.innerHTML = '';
  if (!items.length) {
    container.appendChild(el('div', { class: 'empty' }, 'Nessun risultato'));
    return;
  }
  for (const item of items) {
    const card = el('div', { class: 'card', onclick: () => openDetail(item) }, [
      item.posterUrl
        ? el('img', { src: item.posterUrl, alt: item.title })
        : el('div', { class: 'placeholder' }, item.title),
      el('div', { class: 'info' }, [
        el('div', { class: 'title' }, item.title),
        el('div', { class: 'meta' }, `${item.type === 'tv' ? 'Serie TV' : 'Film'}${item.year ? ' · ' + item.year : ''}`)
      ])
    ]);
    container.appendChild(card);
  }
}

function hideDetail() {
  $('#detail-panel').hidden = true;
  $('#search-results').hidden = false;
  $('#search-form').hidden = false;
}

async function openDetail(item) {
  state.currentItem = item;
  $('#search-results').hidden = true;
  $('#search-form').hidden = true;
  const panel = $('#detail-panel');
  panel.hidden = false;
  const content = $('#detail-content');
  content.innerHTML = '';

  content.appendChild(el('div', { class: 'detail-header' }, [
    item.posterUrl ? el('img', { src: item.posterUrl }) : null,
    el('div', {}, [
      el('h3', {}, `${item.title}${item.year ? ` (${item.year})` : ''}`),
      el('p', {}, item.overview || 'Nessuna descrizione disponibile.')
    ])
  ]));

  if (item.type === 'movie') {
    const streamsWrap = el('div', { class: 'stream-list' }, [el('div', { class: 'empty' }, 'Ricerca stream...')]);
    content.appendChild(streamsWrap);
    await loadStreams(item, {}, streamsWrap);
  } else {
    const seasonWrap = el('div', { class: 'season-select' });
    content.appendChild(seasonWrap);
    const episodeWrap = el('div', { class: 'episode-list' });
    content.appendChild(episodeWrap);
    const streamsWrap = el('div', { class: 'stream-list' });
    content.appendChild(streamsWrap);
    await loadSeasons(item, seasonWrap, episodeWrap, streamsWrap);
  }
}

async function loadSeasons(item, seasonWrap, episodeWrap, streamsWrap) {
  seasonWrap.innerHTML = 'Caricamento stagioni...';
  try {
    const { seasons } = await api(`/seasons/${item.tmdbId}`);
    seasonWrap.innerHTML = '';
    const select = el('select', {});
    for (const s of seasons) {
      select.appendChild(el('option', { value: s.seasonNumber }, `${s.name} (${s.episodeCount} episodi)`));
    }
    seasonWrap.appendChild(el('label', {}, 'Stagione:'));
    seasonWrap.appendChild(select);
    select.addEventListener('change', () => loadEpisodes(item, select.value, episodeWrap, streamsWrap));
    if (seasons.length) loadEpisodes(item, select.value, episodeWrap, streamsWrap);
  } catch (e) {
    seasonWrap.innerHTML = '';
    toast(e.message, true);
  }
}

async function loadEpisodes(item, season, episodeWrap, streamsWrap) {
  episodeWrap.innerHTML = 'Caricamento episodi...';
  streamsWrap.innerHTML = '';
  try {
    const { episodes } = await api(`/episodes/${item.tmdbId}/${season}`);
    episodeWrap.innerHTML = '';
    for (const ep of episodes) {
      const row = el('div', { class: 'episode-row' }, [
        el('span', {}, [
          el('span', { class: 'ep-num' }, `E${String(ep.episodeNumber).padStart(2, '0')}`),
          el('span', { class: 'ep-title' }, ep.name || `Episodio ${ep.episodeNumber}`)
        ])
      ]);
      row.addEventListener('click', () => {
        $all('.episode-row', episodeWrap).forEach(r => r.style.borderColor = '');
        row.style.borderColor = 'var(--accent)';
        loadStreams(item, { season, episode: ep.episodeNumber }, streamsWrap);
      });
      episodeWrap.appendChild(row);
    }
  } catch (e) {
    episodeWrap.innerHTML = '';
    toast(e.message, true);
  }
}

async function loadStreams(item, { season, episode }, streamsWrap) {
  streamsWrap.innerHTML = '<div class="empty">Ricerca stream sugli addon...</div>';
  const params = new URLSearchParams({ tmdbId: item.tmdbId, type: item.type });
  if (season !== undefined) params.set('season', season);
  if (episode !== undefined) params.set('episode', episode);

  try {
    const { streams, errors } = await api(`/streams?${params.toString()}`);
    streamsWrap.innerHTML = '';
    if (errors && errors.length) {
      for (const e of errors) {
        streamsWrap.appendChild(el('div', { class: 'empty' }, `Addon "${e.addonName}": ${e.error}`));
      }
    }
    if (!streams.length) {
      streamsWrap.appendChild(el('div', { class: 'empty' }, 'Nessuno stream trovato'));
      return;
    }
    const title = item.type === 'movie'
      ? `${item.title}${item.year ? ` (${item.year})` : ''}`
      : `${item.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

    for (const s of streams) {
      const row = el('div', { class: 'stream-row' + (s.supported ? '' : ' unsupported') }, [
        el('div', { class: 'stream-info' }, [
          el('div', { class: 'stream-title' }, [
            s.title,
            !s.supported ? el('span', { class: 'tag warn' }, 'non supportato (torrent)') : null
          ]),
          el('div', { class: 'stream-addon' }, s.addonName)
        ]),
        el('button', {
          disabled: s.supported ? null : 'disabled',
          onclick: () => downloadStream(s, title, item.type)
        }, 'Scarica')
      ]);
      streamsWrap.appendChild(row);
    }
  } catch (e) {
    streamsWrap.innerHTML = '';
    toast(e.message, true);
  }
}

async function downloadStream(stream, title, mediaType) {
  try {
    await api('/queue', {
      method: 'POST',
      body: JSON.stringify({
        addonName: stream.addonName,
        sourceUrl: stream.url,
        infoHash: stream.infoHash,
        headers: stream.headers,
        streamTitle: stream.title,
        title,
        mediaType: mediaType === 'tv' ? 'series' : 'movie'
      })
    });
    toast('Aggiunto alla coda di download');
    switchTab('queue');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Queue ----

async function loadQueue() {
  const container = $('#queue-list');
  try {
    const { jobs } = await api('/queue');
    renderQueue(jobs);
  } catch (e) {
    container.innerHTML = '';
    toast(e.message, true);
  }
}

function renderQueue(jobs) {
  const container = $('#queue-list');
  container.innerHTML = '';
  const badge = $('#queue-badge');
  const activeCount = jobs.filter(j => j.status === 'queued' || j.status === 'downloading').length;
  badge.hidden = activeCount === 0;
  badge.textContent = activeCount;

  if (!jobs.length) {
    container.appendChild(el('div', { class: 'empty' }, 'La coda è vuota'));
    return;
  }

  const statusLabel = { queued: 'in coda', downloading: 'download', done: 'completato', error: 'errore' };

  for (const job of jobs) {
    const row = el('div', { class: 'row' }, [
      el('div', { class: 'row-top' }, [
        el('div', {}, [
          el('div', { class: 'row-title' }, job.title),
          el('div', { class: 'row-meta' }, `${job.addonName || ''} · ${job.type === 'hls' ? 'HLS' : 'file diretto'}`)
        ]),
        el('div', { class: 'row-actions' }, [
          el('span', { class: `status-pill status-${job.status}` }, statusLabel[job.status] || job.status),
          el('button', { class: 'danger', onclick: () => removeJob(job.id) }, job.status === 'downloading' ? 'Annulla' : 'Rimuovi')
        ])
      ])
    ]);

    if (job.status === 'downloading') {
      const fillClass = job.progress === null ? 'progress-bar-fill indeterminate' : 'progress-bar-fill';
      const width = job.progress === null ? '' : `width:${job.progress}%`;
      row.appendChild(el('div', { class: 'progress-bar' }, [
        el('div', { class: fillClass, style: width })
      ]));
      const meta = job.progress !== null
        ? `${job.progress}%`
        : (job.downloadedBytes ? humanSize(job.downloadedBytes) + ' scaricati' : 'in corso...');
      row.appendChild(el('div', { class: 'row-meta' }, meta));
    }

    if (job.status === 'error' && job.error) {
      row.appendChild(el('div', { class: 'error-msg' }, job.error));
    }

    container.appendChild(row);
  }
}

async function removeJob(id) {
  try {
    await api(`/queue/${id}`, { method: 'DELETE' });
    loadQueue();
  } catch (e) {
    toast(e.message, true);
  }
}

function startQueuePolling() {
  clearInterval(state.queuePollTimer);
  state.queuePollTimer = setInterval(() => {
    if ($('#tab-queue').classList.contains('active')) loadQueue();
  }, 2000);
}

// ---- Library ----

async function loadLibrary() {
  const container = $('#library-list');
  try {
    const { files } = await api('/library');
    renderLibrary(files);
  } catch (e) {
    container.innerHTML = '';
    toast(e.message, true);
  }
}

function renderLibrary(files) {
  const container = $('#library-list');
  container.innerHTML = '';
  if (!files.length) {
    container.appendChild(el('div', { class: 'empty' }, 'Nessun file scaricato'));
    return;
  }
  for (const f of files) {
    const row = el('div', { class: 'row' }, [
      el('div', { class: 'row-top' }, [
        el('div', {}, [
          el('div', { class: 'row-title' }, f.filename),
          el('div', { class: 'row-meta' }, `${humanSize(f.sizeBytes)} · ${humanDate(f.modifiedAt)}`)
        ]),
        el('div', { class: 'row-actions' }, [
          el('button', { class: 'secondary', onclick: () => playFile(f.filename) }, 'Riproduci'),
          el('button', { class: 'danger', onclick: () => deleteFile(f.filename) }, 'Elimina')
        ])
      ])
    ]);
    container.appendChild(row);
  }
}

function playFile(filename) {
  const wrap = $('#player-wrap');
  const player = $('#player');
  player.src = `/media/${encodeURIComponent(filename)}`;
  wrap.hidden = false;
  wrap.scrollIntoView({ behavior: 'smooth' });
  player.play().catch(() => {});
}

$('#player-close').addEventListener('click', () => {
  const wrap = $('#player-wrap');
  const player = $('#player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  wrap.hidden = true;
});

async function deleteFile(filename) {
  if (!confirm(`Eliminare "${filename}"?`)) return;
  try {
    await api(`/library/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    loadLibrary();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Addons ----

async function loadAddons() {
  const container = $('#addon-list');
  try {
    const { addons } = await api('/addons');
    renderAddons(addons);
  } catch (e) {
    container.innerHTML = '';
    toast(e.message, true);
  }
}

function renderAddons(addons) {
  const container = $('#addon-list');
  container.innerHTML = '';
  if (!addons.length) {
    container.appendChild(el('div', { class: 'empty' }, 'Nessun addon configurato'));
    return;
  }
  for (const a of addons) {
    const row = el('div', { class: 'row' }, [
      el('div', { class: 'row-top' }, [
        el('div', {}, [
          el('div', { class: 'row-title' }, a.name),
          el('div', { class: 'row-meta' }, a.manifestUrl)
        ]),
        el('div', { class: 'row-actions' }, [
          el('button', { class: 'danger', onclick: () => deleteAddon(a.id) }, 'Rimuovi')
        ])
      ])
    ]);
    container.appendChild(row);
  }
}

function initAddonForm() {
  $('#addon-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#addon-name').value.trim();
    const manifestUrl = $('#addon-url').value.trim();
    if (!name || !manifestUrl) return;
    try {
      await api('/addons', { method: 'POST', body: JSON.stringify({ name, manifestUrl }) });
      $('#addon-name').value = '';
      $('#addon-url').value = '';
      loadAddons();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

async function deleteAddon(id) {
  try {
    await api(`/addons/${id}`, { method: 'DELETE' });
    loadAddons();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- Init ----

initTabs();
initSearch();
initAddonForm();
startQueuePolling();
loadQueue();

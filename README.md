# nuvio-offline

Web app self-hosted (Node.js/Express) per scaricare offline contenuti video trovati tramite
addon Stremio/Nuvio, così da poterli guardare senza connessione (es. in aereo).

> **Uso previsto**: scaricare solo contenuti per cui hai i diritti di visione. Lo strumento
> non fornisce contenuti propri: interroga addon Stremio configurati da te ed effettua un
> semplice remux/download dello stream indicato dall'addon.

## Funzionalità

- Ricerca film/serie TV su TMDB, selezione stagione/episodio per le serie
- Interrogazione di uno o più addon stream Stremio (protocollo standard `/stream/{type}/{id}.json`)
- Coda di download persistente con stati `queued` / `downloading` / `done` / `error`
- Download HLS (.m3u8) via `ffmpeg -c copy` (remux, nessuna ricodifica), con supporto header
  `Referer` / `User-Agent` richiesti dallo stream
- Download diretto in streaming per file mp4/mkv/ecc.
- Libreria dei file scaricati con player HTML5 integrato ed eliminazione

## Requisiti

- Node.js ≥ 18 (usa `fetch` nativo)
- `ffmpeg` installato e disponibile nel `PATH` (richiesto per gli stream HLS)
- Una API key gratuita di TMDB

### Come ottenere una API key TMDB gratuita

1. Crea un account su https://www.themoviedb.org/signup
2. Vai su https://www.themoviedb.org/settings/api
3. Richiedi una API key di tipo "Developer" (uso non commerciale, gratuita)
4. Copia la "API Key (v3 auth)" e incollala nel campo `tmdbApiKey` di `config.json`

## Configurazione

Copia `config.example.json` in `config.json` e imposta la tua API key:

```bash
cp config.example.json config.json
```

Campi principali:

| Campo                | Descrizione                                                        |
|-----------------------|---------------------------------------------------------------------|
| `tmdbApiKey`          | API key v3 di TMDB                                                 |
| `language`             | Lingua risultati/metadati TMDB (es. `it-IT`)                        |
| `port`                 | Porta HTTP dell'app (default `4321`)                                |
| `concurrentDownloads`  | Numero massimo di download simultanei                               |
| `downloadsPath`        | Cartella dove salvare i file scaricati                              |
| `dataPath`             | Cartella dati applicativi (coda persistente)                        |
| `addons`               | Lista addon Stremio (gestibile anche dalla UI, tab "Addon")         |

Gli addon si aggiungono anche a runtime dalla tab **Addon** dell'interfaccia (nome +
URL del `manifest.json`), senza dover modificare `config.json` a mano.

## Avvio senza Docker

```bash
npm install
cp config.example.json config.json   # poi modifica tmdbApiKey
node server.js
```

App disponibile su http://localhost:4321. Assicurati che `ffmpeg` sia installato
(`ffmpeg -version` deve funzionare nel terminale).

## Avvio con Docker

```bash
cp config.example.json config.json   # poi modifica tmdbApiKey
docker compose up -d --build
```

L'immagine (`node:22-alpine`) include `ffmpeg` via `apk`. Il `docker-compose.yml` monta
`config.json`, `downloads/` e `data/` come volumi persistenti, così configurazione, file
scaricati e coda sopravvivono ai riavvii del container.

## Note su header/proxy degli stream

Alcuni addon restituiscono stream che richiedono header specifici (es. `Referer`,
`User-Agent`) tramite `behaviorHints.proxyHeaders.request` nella risposta
`/stream/{type}/{id}.json`. L'app li inoltra automaticamente:

- per stream HLS, passati a `ffmpeg` con `-headers`
- per download diretti, passati come header della richiesta HTTP

Gli stream che espongono solo un `infoHash` (torrent/magnet) senza un `url` diretto
**non sono scaricabili** da questo strumento e vengono mostrati come "non supportati"
nella lista degli stream.

## Limiti noti

- **Nessuna autenticazione integrata.** L'app non ha login: chiunque possa raggiungere
  la porta esposta può cercare, scaricare ed eliminare file. Se esponi l'app oltre alla
  tua rete locale, mettila dietro una VPN o un reverse proxy con autenticazione
  (es. Basic Auth su Nginx/Traefik, o un tunnel tipo Tailscale).
- Il remux HLS con `-c copy` funziona quando i codec sorgente sono compatibili con il
  container di output (`.mkv`, scelto proprio per la sua tolleranza sui codec); se lo
  stream usa codec non supportati dal player HTML5 del browser, la riproduzione
  nella Libreria potrebbe non funzionare pur avendo scaricato correttamente il file.
- Stream con solo `infoHash` (torrent) non sono gestiti: servirebbe un client BitTorrent,
  fuori dallo scope di questo tool.

## Struttura del progetto

```
server.js           # route Express
src/config.js        # caricamento/scrittura config.json
src/addons.js         # ricerca TMDB + query addon stream Stremio
src/downloader.js     # coda di download, ffmpeg, download diretto
src/library.js         # gestione file scaricati
public/                # frontend statico (HTML/CSS/JS vanilla)
```

## API REST

| Metodo | Path                              | Descrizione                              |
|--------|-------------------------------------|--------------------------------------------|
| GET    | `/api/search?query=`                | Ricerca titoli su TMDB                     |
| GET    | `/api/seasons/:tmdbId`              | Stagioni di una serie TV                   |
| GET    | `/api/episodes/:tmdbId/:season`     | Episodi di una stagione                    |
| GET    | `/api/streams?tmdbId=&type=&season=&episode=` | Stream trovati dagli addon        |
| GET    | `/api/addons`                       | Lista addon configurati                    |
| POST   | `/api/addons`                       | Aggiunge un addon (`name`, `manifestUrl`)  |
| DELETE | `/api/addons/:id`                   | Rimuove un addon                           |
| GET    | `/api/queue`                        | Stato della coda di download               |
| POST   | `/api/queue`                        | Accoda un download                         |
| DELETE | `/api/queue/:id`                    | Annulla/rimuove un job dalla coda          |
| GET    | `/api/library`                      | Lista file scaricati                       |
| DELETE | `/api/library/:filename`            | Elimina un file scaricato                  |

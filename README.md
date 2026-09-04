# nuvio-offline

Web app self-hosted (Node.js/Express) per scaricare offline contenuti video trovati tramite
addon Stremio/Nuvio, così da poterli guardare senza connessione (es. in aereo).

> **Uso previsto**: scaricare solo contenuti per cui hai i diritti di visione. Lo strumento
> non fornisce contenuti propri: interroga addon Stremio configurati da te ed effettua un
> semplice remux/proxy dello stream indicato dall'addon.

## Come funziona il download

nuvio-offline **non salva nulla sul server**. Quando premi "Scarica sul dispositivo":

- se lo stream è un **file diretto** (mp4/mkv/ecc.), il server fa da semplice proxy: apre
  la connessione allo stream e ne inoltra i byte al tuo browser mano a mano che arrivano;
- se lo stream è **HLS (.m3u8)**, il server avvia `ffmpeg -c copy` (remux, nessuna
  ricodifica) e ne trasmette l'output in streaming (pipe), senza mai scriverlo su disco;

in entrambi i casi la risposta HTTP arriva con `Content-Disposition: attachment`, quindi è
il **browser del dispositivo da cui hai aperto la pagina** (es. il telefono/tablet dove usi
Nuvio) a salvare il file nella sua cartella Download tramite il download manager nativo.
Il server (es. una Raspberry Pi con poco storage) non accumula mai file: fa solo da
tramite/convertitore per la durata del download.

> Nota tecnica: un addon Stremio/Nuvio è solo un endpoint che risponde con JSON
> (catalogo/stream) — non può in alcun modo comandare all'app Nuvio di scaricare file sul
> dispositivo. Per questo nuvio-offline resta una web app separata: la apri dal browser
> dello stesso device dove usi Nuvio, e il download finisce lì.

## Funzionalità

- Ricerca film/serie TV su TMDB, selezione stagione/episodio per le serie
- Interrogazione di uno o più addon stream Stremio (protocollo standard `/stream/{type}/{id}.json`)
- Download diretto verso il dispositivo del browser, zero storage sul server
- Header `Referer` / `User-Agent` richiesti dallo stream inoltrati automaticamente
  (sia per il remux ffmpeg che per il proxy diretto)

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
| `concurrentDownloads`  | Numero massimo di trasferimenti (remux/proxy) simultanei            |
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

L'immagine (`node:22-alpine`) include `ffmpeg` via `apk`. Non servono volumi per i file
scaricati (non vengono mai scritti su disco): il `docker-compose.yml` monta solo
`config.json`, così configurazione e lista addon sopravvivono ai riavvii del container.

## Installazione come addon dentro Nuvio

Oltre alla sua web UI, nuvio-offline si espone anche come **addon Stremio/Nuvio**
(`/manifest.json` + `/stream/:type/:id.json`). Installandolo dentro Nuvio, quando cerchi
un film/serie compare, insieme agli stream normali, una voce "⬇️ Scarica offline" per
ogni stream scaricabile trovato dagli addon "sorgente" già configurati in nuvio-offline —
niente più bisogno di cercare separatamente nella web UI.

1. In Nuvio, vai nelle impostazioni addon e aggiungi come URL manifest:
   `http://<ip-o-host-della-rpi>:4321/manifest.json`
2. Cerca un titolo in Nuvio come al solito: tra gli stream trovati vedrai anche le voci
   "⬇️ Scarica offline" prodotte da nuvio-offline.
3. Selezionandone una, l'addon usa `externalUrl` (invece di `url`): Nuvio dovrebbe aprirla
   nel browser esterno del device invece di riprodurla internamente — è lì che parte il
   download, stesso meccanismo della web UI.

> Non è garantito che ogni app "addon-compatible" rispetti `externalUrl` esattamente come
> Stremio ufficiale: è lo standard previsto dal protocollo, ma vale la pena verificarlo con
> un test rapido dopo l'installazione.

## Note su header/proxy degli stream

Alcuni addon restituiscono stream che richiedono header specifici (es. `Referer`,
`User-Agent`) tramite `behaviorHints.proxyHeaders.request` nella risposta
`/stream/{type}/{id}.json`. L'app li inoltra automaticamente sia per il remux `ffmpeg`
(`-headers`) sia per il proxy diretto (header della richiesta HTTP verso lo stream).

Gli stream che espongono solo un `infoHash` (torrent/magnet) senza un `url` diretto
**non sono scaricabili** da questo strumento e vengono mostrati come "non supportati"
nella lista degli stream.

## Limiti noti

- **Nessuna autenticazione integrata.** L'app non ha login: chiunque possa raggiungere
  la porta esposta può cercare e avviare download. Se esponi l'app oltre alla tua rete
  locale, mettila dietro una VPN o un reverse proxy con autenticazione (es. Basic Auth
  su Nginx/Traefik, o un tunnel tipo Tailscale).
- **Il progresso del download è quello nativo del browser**, non c'è una barra di
  avanzamento nell'app: dato che il file passa in streaming dal server al browser senza
  fermarsi da nessuna parte, è il download manager del tuo dispositivo (es. le notifiche
  di download di Android) a mostrare l'avanzamento.
- Se lo stream fallisce **dopo** che il download è già iniziato (es. connessione persa a
  metà), il browser mostrerà un download interrotto/incompleto: va semplicemente
  riavviato. Se fallisce **prima** di iniziare (URL non raggiungibile, ffmpeg non
  installato, ecc.), il browser segnala il download come non riuscito.
- Se la sorgente non risponde affatto (host lento/irraggiungibile, autenticazione non
  gestita, ecc.), dopo **30 secondi** senza ricevere alcun dato il download viene
  interrotto con un errore invece di restare in attesa indefinitamente.
- Alcuni CDN legano l'URL firmato dello stream all'IP (e talvolta al Referer) di chi lo
  ha generato — nel nostro caso il device dove gira Nuvio. Se il nostro server prova a
  scaricarlo da un IP diverso, il CDN può rispondere 403 anche inoltrando gli stessi
  header. Per i file diretti (non HLS), in questo caso il server reindirizza
  automaticamente il browser a scaricare direttamente dalla fonte (stesso IP di chi ha
  generato il link): funziona, ma si perde il download forzato con nome file automatico
  (il browser potrebbe riprodurre il video invece di scaricarlo, a seconda del CDN).
  Per l'HLS via ffmpeg questo fallback non è applicabile (Android/Chrome non riproduce
  `.m3u8` nativamente), quindi se un CDN blocca per IP anche gli stream HLS non c'è
  attualmente un workaround.
- Il remux HLS con `-c copy` funziona quando i codec sorgente sono compatibili con il
  container di output (`.mkv`, scelto per la sua tolleranza sui codec).
- Stream con solo `infoHash` (torrent) non sono gestiti: servirebbe un client BitTorrent,
  fuori dallo scope di questo tool.
- Devi aprire nuvio-offline dal **browser dello stesso dispositivo** su cui vuoi che il
  file scaricato finisca (es. il telefono/tablet dove usi Nuvio).

## Struttura del progetto

```
server.js           # route Express
src/config.js         # caricamento/scrittura config.json
src/addons.js          # ricerca TMDB + query addon stream Stremio
src/streamer.js        # streaming diretto del download (proxy HTTP / remux ffmpeg in pipe)
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
| GET    | `/api/download?data=`               | Avvia lo streaming del download (`data` è un JSON URL-encoded con `sourceUrl`, `headers`, `title`, ecc.) |
| GET    | `/manifest.json`                    | Manifest addon Stremio/Nuvio                |
| GET    | `/stream/:type/:id.json`            | Stream "scaricabili" per l'addon (protocollo Stremio) |

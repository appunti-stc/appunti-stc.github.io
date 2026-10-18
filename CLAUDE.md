# Contesto del progetto — "Appunti per STC"

Sito per gli studenti di **Scienze e Tecnologie Chimiche (UniMiB)** per condividere appunti, PDF,
immagini, audio e video. Fatto da Aleksey Symonenko (rappresentante, utente non tecnico).

## Come lavorare con l'utente
- Scrive in **italiano**, usa **iPad o Mac**, non è uno sviluppatore: spiegazioni semplici e
  **passo passo**, con link diretti ai file su GitHub da copiare (icona "due quadratini").
- Se chiede "non fare nulla senza conferma" → rispondi soltanto.
- Vuole costo **0 €**. Repository **pubblico**: mai mettere nel codice contatti personali
  (telefoni, link WhatsApp) o chiavi segrete; quei dati vanno nel database.

## Architettura (tutto gratuito)
- **Sito statico** in `docs/` pubblicato da **GitHub Pages** (ramo `claude/elearning-university-auth-dep8hk`,
  cartella `/docs`): https://appunti-stc.github.io/ (repository `appunti-stc/appunti-stc.github.io`, organizzazione GitHub;
  prima era `AlekseySymonenko/Sito-UNI-STC`: il vecchio indirizzo rimanda qui con i file di `vecchio-indirizzo/`)
- **Supabase** (progetto `bbyaljjyjfhufesjxycf`): login Google, database Postgres con Row Level
  Security, archivio file Supabase (1 GB, file vecchi) e Edge Function **`B2`** (nome MAIUSCOLO,
  "Verify JWT" disattivato).
- **Backblaze B2**: bucket `appunti-stc-bicocca-2026`, endpoint `s3.eu-central-003.backblazeb2.com`,
  tetti di spesa a $0, ciclo di vita "keep only last version". Chiavi nei Secrets della funzione
  (`B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT`). Limite 9,5 GB con pulizia automatica.
- **Cloudflare R2** (registrazioni audio/video, 10 GB gratis, download illimitati): bucket previsto
  `appunti-stc-registrazioni`; Secrets `R2_ACCOUNT_ID`, `R2_KEY_ID`, `R2_APP_KEY`, `R2_BUCKET`. Senza R2 tutto va su B2.
  `files.storage` = 'supabase' | 'b2' | 'r2'. Limite 9,5 GB su B2 e 8 GB su R2 (R2 non ha tetto di spesa: margine per i picchi del robot), pulizia separata.
- **Robot** GitHub Actions (`.github/workflows/robot.yml` + `drive-import/robot.py`, ogni ora): comprime le
  registrazioni su R2 (audio AAC mono 48k .m4a, video H.264 720p .mp4) e scompatta gli ZIP (ripresa senza doppioni).
  Secrets GitHub: `SERVICE_TOKEN` + i 4 R2. Il ramo di default è quello del sito (serve per lo schedule).
- **Codice di servizio** (Amministrazione → Importazione): usato da script Google e robot; nel DB solo l'hash
  (`app_settings.service_token_hash`); RPC `import_*` e `robot_*` lo verificano.
- **Google OAuth** (Google Cloud, app "e-Learning Bicocca", in produzione) collegato a Supabase.
- Accesso consentito solo a `@campus.unimib.it` (controllato dal database, `is_campus()`).

## File principali
- `docs/config.js` impostazioni (URL/chiave pubblica Supabase, `storage: 'b2'`, `b2FunctionName: 'B2'`).
- `docs/js/api.js` accesso ai dati (SupabaseApi + DemoApi per l'anteprima).
- `docs/js/app.js` tutte le pagine (router su `#/...`), `docs/js/leagues.js` leghe e stemmi SVG.
- `docs/index.html` (icone SVG, CSP), `docs/css/style.css`, `docs/privacy.html`.
- `supabase/setup.sql` schema + permessi, **rieseguibile** (idempotente).
- `supabase/professori.sql` 62 docenti (inseriti solo se tabella vuota).
- `supabase/functions/b2/index.ts` firma link S3 (SigV4) per B2 e R2, quota, pulizia, CORS automatico (B2),
  azioni `import-begin/part/finish/abort` (caricamento a parti da 32 MB) per lo script del Drive.
- `drive-import/inventario.gs` (inventario Drive, solo lettura), `drive-import/importa.gs` (trasferimento Drive →
  archivi, elenco `ANNI` corso→anno), `drive-import/robot.py`.

## Funzionalità presenti
Corsi per laurea (triennale 1–3, magistrale 1–2) e **anno accademico** (menu, normalizzato), menu ⋯
sulle schede per modificare/spostare (solo admin); upload su B2 fino a 500 MB; anteprime
PDF/immagini/audio/video; dashboard con i corsi aperti di recente (tabella `course_visits`, uguale su ogni dispositivo; localStorage solo di riserva); ricerca; classifica a leghe (punti: +10 file max 10/giorno, +5 a chi carica per ogni studente diverso
che apre il file, +1 a chi apre un file nuovo max 5/giorno (`file_opens.reader_points`), −10 se un admin elimina;
per gli autori Drive non iscritti `import_credits.view_points`); segnalazioni, sospensione utenti; file protetti 📌; pulizia
automatica per archivio (documenti: aperture ultimi 548 giorni; registrazioni: 365; mai file < 14 giorni né
importati da < 6 mesi); importazione Drive con punti (+10/file, nessun tetto, accreditati anche al primo accesso
via `import_pending`/`import_credits`); formati extra .cif/.mryx; badge "Nuovo" (`visit()`, profiles.seen_at/prev_seen_at); preferiti ⭐ (`course_favorites`);
voti "Utile" (`file_votes`, `toggle_vote`, +3 punti); cartelle (`files.folder`, `set_folder`); ordinamento e avviso
doppioni nel corso; statistiche admin (`admin_stats`); tour di benvenuto (`docs/js/tour.js`, profiles.onboarded_at);
PWA (`docs/manifest.webmanifest`, icone in `docs/img/`); tema scuro (variabili CSS, `--mix`, `--brand`) automatico o scelto col
pulsante ☾/☀ (`docs/js/theme.js`, `html[data-theme]`, salvato in localStorage); versione telefono/tablet compatta (fine di `style.css`:
nessun elemento più largo dello schermo, campi a 16px per evitare lo zoom di iOS, corsi su 2 colonne); pagine Rappresentanti e
Professori (dati nel DB, modificabili dagli admin); firma "Fatto con ♥ da Aleksey Symonenko".
Studenti: vedono tutto, caricano, creano corsi, segnalano. Admin: modificano/eliminano tutto,
gestiscono ruoli, sospensioni, contenuti delle pagine. Il primo utente è diventato admin.

## Regole tecniche
- **Versione**: a ogni modifica di CSS/JS aggiorna lo stesso valore in `docs/index.html`
  (`data-v` e tutti i `?v=`) e `VERSION` in `docs/js/app.js` (il sito si ricarica da solo se vecchio).
- **CSP**: niente stili o script inline (usare classi CSS; larghezze via `data-width`).
- Modifiche al DB → aggiornare `setup.sql` (idempotente) e dire all'utente di rieseguirlo; se il
  nuovo sito dipende da nuove colonne, valutare l'ordine (sito compatibile con DB vecchio).
- Modifiche a `functions/b2/index.ts` → l'utente deve ripubblicare la funzione `B2` su Supabase.
- Dall'ambiente cloud non si raggiungono Supabase, Backblaze né github.io: verificare con mock.

## Test
- Permessi SQL (PostgreSQL locale): `sh supabase/tests/run.sh` (come utente postgres).
- Funzione B2: `node --experimental-strip-types --test supabase/functions/b2/test/*.test.ts`
  e `npx -y deno@2.1.4 check supabase/functions/b2/index.ts`.
- Interfaccia: servire `docs/` e usare Playwright (`/opt/node-tools/node_modules/playwright`),
  con `supabaseUrl: ''` per la modalità anteprima.

## Test aggiuntivi
- Script Google: `node drive-import/test/importa.test.cjs` (Drive/Fogli/UrlFetch finti + vera funzione B2 in un
  worker, file grandi a parti, pause, archivio pieno). Il robot si prova con PostgREST reale + moto (S3 finto) + ffmpeg.

## In sospeso
- **Importazione dal vecchio Drive: completata.** (cartella `Scienze e Tecnologie Chimiche`, 704 file, 23,6 GB, 69 autori;
  ~20 GB sono registrazioni): codice pronto. L'utente deve: rieseguire setup.sql, configurare R2, ripubblicare B2,
  generare il codice, Secrets GitHub (fatto: R2 e robot funzionano), poi avviare `importa.gs`. `ANNI` e `NOMI` presi dai
  regolamenti 2026/27 (E2703Q, F5402Q); solo corsi con file, niente corsi vuoti.
- Possibili: nuovi formati (.key, .pages, .rtf, .csv).

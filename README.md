# Sito per studenti da studenti per condividere appunti

Piattaforma in stile e-learning universitario per condividere i materiali dei corsi:
**PDF, immagini, audio, video e documenti** (slide, dispense, appunti).

- 🔐 Accesso **solo con l'account Google @campus.unimib.it**: il sito non vede né salva password.
- ⬆️ **Tutti gli studenti** possono creare corsi e caricare file.
- 🗑️ **Solo gli amministratori** possono eliminare file e corsi (o modificarli).
- 🛡️ Pagina **Amministrazione** per nominare altri amministratori, con registro delle attività.
- 💶 **Costo: 0 €.** Pagine su GitHub Pages, login/dati/file su Supabase (piano gratuito).

> **Gli studenti non devono usare GitHub.** Per loro è un normale sito: aprono il link,
> premono «Accedi con l'account @campus.unimib.it» e basta. GitHub e Supabase servono solo
> a chi gestisce il sito, e si configurano **una volta sola** (da iPad va benissimo).

---

## Configurazione (una volta sola, circa 30 minuti)

### Passo 1 · Pubblicare il sito su GitHub Pages
1. In questo repository: **Settings → Pages**.
2. In *Build and deployment*: Source **Deploy from a branch**, poi scegli il ramo
   `claude/elearning-university-auth-dep8hk` e la cartella **`/docs`** → **Save**.
3. Dopo 1–2 minuti il sito è online su `https://alekseysymonenko.github.io/Sito-UNI-STC/`.

Finché il passo 2 non è completato il sito funziona in **modalità anteprima** (dati di esempio).

### Passo 2 · Creare il progetto Supabase (gratis, senza carta di credito)
1. Vai su <https://supabase.com> → **Start your project** → accedi con GitHub.
2. **New project**: nome `elearning-bicocca`, scegli una password per il database
   (salvala, non servirà al sito), regione **Central EU (Frankfurt)** → **Create**.
3. Quando è pronto: menu a sinistra **SQL Editor** → **New query** → incolla tutto il contenuto
   del file [`supabase/setup.sql`](supabase/setup.sql) → **Run**. Deve comparire "Success".
4. Pulsante **Connect** in alto (oppure *Project Settings → API*): copia
   **Project URL** e **anon public key**. *(Non usare mai la chiave "service_role/secret".)*

### Passo 3 · Attivare il login con Google
1. Vai su <https://console.cloud.google.com> e crea un progetto (es. `elearning-bicocca`).
2. **API e servizi → Schermata consenso OAuth**: tipo **Esterno**, nome app, email di supporto,
   poi **Pubblica app**.
3. **Credenziali → Crea credenziali → ID client OAuth → Applicazione web**:
   - *Origini JavaScript autorizzate*: `https://alekseysymonenko.github.io`
   - *URI di reindirizzamento autorizzati*: `https://<il-tuo-progetto>.supabase.co/auth/v1/callback`
     (lo trovi già scritto su Supabase in *Authentication → Sign In / Providers → Google*)
4. Copia **ID client** e **Client secret**.
5. Su Supabase: **Authentication → Sign In / Providers → Google** → attiva, incolla ID e secret → **Save**.
6. Su Supabase: **Authentication → URL Configuration**:
   - *Site URL*: `https://alekseysymonenko.github.io/Sito-UNI-STC/`
   - *Redirect URLs*: aggiungi `https://alekseysymonenko.github.io/Sito-UNI-STC/`

### Passo 4 · Collegare il sito a Supabase
Apri il file [`docs/config.js`](docs/config.js), tocca la matita ✏️ e incolla
**Project URL** e **anon public key** tra le virgolette di `supabaseUrl` e `supabaseAnonKey`
→ **Commit changes**. Dopo un minuto il sito è collegato.

### Passo 5 · Diventare amministratore
**La prima persona che accede diventa automaticamente amministratore**: entra subito tu.
Poi dalla pagina **Amministrazione** puoi nominare altri amministratori.

---

## Archivio grande con Backblaze B2 (facoltativo, 10 GB gratis)

Al posto dell'archivio di Supabase (1 GB) i file possono andare su **Backblaze B2**:
10 GB gratuiti, file fino a 500 MB, nessun costo grazie al tetto di spesa a 0 $ e al
limite impostato nel sito (i caricamenti si bloccano a 9,5 GB).

1. **Account**: su <https://www.backblaze.com/sign-up/cloud-storage> registrati (meglio con l'email
   dei rappresentanti) scegliendo la regione **EU Central**.
2. **Tetto di spesa**: menu *Caps & Alerts* → imposta **tutti i limiti giornalieri a $0** → *Update*.
3. **Bucket**: *Buckets → Create a Bucket* → nome univoco (es. `appunti-stc-bicocca-2026`),
   *Files in Bucket*: **Private** → *Create*. Annota l'**Endpoint** (es. `s3.eu-central-003.backblazeb2.com`).
4. **Chiave**: *Application Keys → Add a New Application Key* → nome `sito`,
   *Allow access to Bucket(s)*: **All**, *Type of Access*: **Read and Write** → *Create*.
   Copia subito **keyID** e **applicationKey** (la seconda viene mostrata una sola volta).
5. **Database**: su Supabase riesegui tutto [`supabase/setup.sql`](supabase/setup.sql) nello SQL Editor.
6. **Funzione**: Supabase → *Edge Functions → Deploy a new function → Via Editor* → nome **`b2`** →
   incolla tutto [`supabase/functions/b2/index.ts`](supabase/functions/b2/index.ts) → *Deploy*.
   Nei dettagli della funzione disattiva **"Verify JWT"** (la funzione controlla da sola chi la chiama).
7. **Secrets**: *Edge Functions → Secrets* → aggiungi `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET` (nome del
   bucket), `B2_ENDPOINT` (l'endpoint del punto 3).
8. In [`docs/config.js`](docs/config.js) imposta `storage: 'b2'` e `maxUploadMb: 500`.

I file già caricati su Supabase restano visibili; i nuovi vanno su B2.
La chiave di B2 resta solo nei Secrets di Supabase: il sito non la vede mai.

### Pulizia automatica dello spazio
Ogni archivio ha un limite: 9,5 GB su Backblaze (documenti) e 8 GB su Cloudflare (registrazioni, con 2 GB di margine
perché lì non esiste un tetto di spesa).
Se un nuovo file non ci sta, il sistema elimina **solo quanto basta e solo da quell'archivio**, scegliendo:
1. i file aperti meno volte (ogni studente conta al massimo una volta al giorno): per i **documenti**
   si contano le aperture dell'**ultimo anno e mezzo**, per le **registrazioni** dell'**ultimo anno**;
2. a parità, quelli aperti (o caricati) meno di recente.

Non vengono mai eliminati i file caricati da meno di 14 giorni, quelli **importati dal vecchio Drive nei
primi 6 mesi** e quelli **protetti 📌** (pulsante nella pagina del file, solo amministratori). Se non c'è
abbastanza da eliminare, il caricamento viene rifiutato. In *Amministrazione* si vedono i prossimi file
eliminabili e nel registro attività ogni eliminazione automatica.

I numeri si cambiano dallo SQL Editor di Supabase, per esempio:
`update app_settings set value = '30' where key = 'evict_grace_days';`
(chiavi: `b2_quota_bytes`, `r2_quota_bytes`, `evict_grace_days`, `evict_window_days` (registrazioni),
`evict_window_days_docs` (documenti), `import_grace_days`, `import_points_per_file`, `import_points_cap`).

## Registrazioni su Cloudflare R2 (10 GB gratis, download illimitati)

Audio e video vanno su **Cloudflare R2**: altri 10 GB gratuiti e, soprattutto, download gratuiti senza
limiti (Backblaze ne concede 1 GB al giorno). Finché R2 non è configurato, tutto continua ad andare su B2.
Un **robot su GitHub** (gratuito) comprime ogni ora le registrazioni nuove: audio in qualità voce
(circa 20 MB per ora di lezione), video in 720p; gli ZIP di registrazioni vengono scompattati.

1. **Account**: <https://dash.cloudflare.com/sign-up> → registrati e conferma l'email.
2. **R2**: menu a sinistra *R2 Object Storage* → attiva il piano gratuito (chiede una carta: nessun addebito
   sotto i 10 GB, e il sito si ferma a 9,5 GB).
3. **Bucket**: *Create bucket* → nome `appunti-stc-registrazioni`, *Location: Automatic* → *Create bucket*.
4. **CORS**: nel bucket → *Settings* → *CORS Policy* → *Add CORS policy* → incolla:
   ```json
   [{"AllowedOrigins":["https://alekseysymonenko.github.io"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]
   ```
5. **Chiave**: pagina *R2 Object Storage* → *Manage API tokens* → *Create API token* → permessi
   **Object Read & Write**, solo il bucket appena creato → *Create*. Copia **Access Key ID** e
   **Secret Access Key** (mostrata una volta sola). L'**Account ID** è nella pagina R2 (a destra).
6. **Supabase** → *Edge Functions → Secrets*: aggiungi `R2_ACCOUNT_ID`, `R2_KEY_ID` (Access Key ID),
   `R2_APP_KEY` (Secret Access Key), `R2_BUCKET` (`appunti-stc-registrazioni`). Poi ripubblica la funzione **B2**
   con il nuovo [`supabase/functions/b2/index.ts`](supabase/functions/b2/index.ts).
7. **Codice di servizio**: sito → *Amministrazione* → *Importazione dal vecchio Drive* → *Genera il codice di servizio* → copia.
8. **GitHub** (robot): questo repository → *Settings → Secrets and variables → Actions → New repository secret*:
   `SERVICE_TOKEN` (il codice del punto 7), `R2_ACCOUNT_ID`, `R2_KEY_ID`, `R2_APP_KEY`, `R2_BUCKET`.
   Prova: *Actions → Robot compressione registrazioni → Run workflow* → deve diventare verde.

Le chiavi si incollano **solo** su Supabase e GitHub (Secrets cifrati): non vanno mai scritte nel codice o in chat.

## Importazione dal vecchio Drive

Lo script [`drive-import/importa.gs`](drive-import/importa.gs) gira sui server di Google e manda i file
**direttamente** agli archivi del sito: niente da scaricare sul computer, nulla viene modificato sul Drive.
- Struttura: `Triennale|Magistrale / Corso / sottocartelle` → laurea, corso (anno di corso dall'elenco `ANNI`
  nello script; i corsi non elencati vanno in *Da assegnare*), sottocartelle nella descrizione del file.
- **Anno accademico** dalla data di caricamento su Drive (dal 1° settembre si passa all'anno successivo):
  lo stesso corso con file di anni diversi diventa un corso per ogni anno accademico.
- Saltati: file di sistema del Mac (`._…`, `__MACOSX`), doppioni "Copia di…", file fuori dalle cartelle dei corsi,
  formati non ammessi. I Documenti Google diventano PDF (i Fogli diventano Excel).
- **Punti**: +10 per ogni file importato, senza tetto (`import_points_per_file`; `import_points_cap` = 0).
  Chi è già iscritto li riceve subito; chi si iscrive dopo li riceve al primo accesso, insieme ai suoi file.
- Se l'archivio delle registrazioni è pieno, lo script aspetta che il robot abbia compresso i file e poi riprende.

Come si usa: script.google.com (con l'account che vede il Drive) → *Nuovo progetto* → incolla `importa.gs` →
scrivi `CARTELLA` (link della cartella) e `CODICE` (codice di servizio) → controlla `ANNI` → funzione **avvia** →
*Esegui* → autorizza. Lo script lavora a blocchi e riparte da solo; l'avanzamento è nel foglio
"Importazione Drive" e in *Amministrazione*. Se qualche file finisce in errore: funzione **riprova_errori**.
Si può rieseguire senza creare doppioni.

## Corsi per laurea e anno

La pagina *Corsi* è divisa in **Laurea Triennale** (1°–3° anno) e **Laurea Magistrale** (1°–2° anno);
i corsi senza collocazione stanno in **Da assegnare**. Nel menu laterale, sotto *Corsi*, la voce
**Anno di corso** porta direttamente a ogni anno. Chi crea un corso sceglie laurea e anno;
gli amministratori possono **modificare o spostare** un corso dal menu **⋯** sulla sua scheda.

**Anno accademico**: nel modulo del corso si sceglie da un menu (es. 2026/2027) e la pagina *Corsi*
raggruppa automaticamente i corsi per anno accademico, con un menu a tendina in alto (preimpostato
sull'anno in corso; da settembre passa al successivo). Gli anni scritti a mano in altri formati
(es. "2026-27") vengono riconosciuti e uniformati.

## Dashboard personale

La dashboard mostra a ciascuno i **corsi aperti di recente** (pagina del corso o un suo file),
dal più recente; l'elenco è salvato sull'account, quindi è lo stesso su iPad, Mac e telefono.
Chi non ha ancora aperto corsi vede quelli con più materiali.

## Funzioni per gli studenti

- **Badge "Nuovo"**: i file caricati da altri dopo la tua ultima visita (e "+N nuovi" sui corsi).
- **Corsi preferiti ⭐**: la stellina su ogni corso; i preferiti stanno sempre in cima alla dashboard.
- **Utile 👍**: un voto per file (non i propri); chi ha caricato riceve +3 punti per voto.
- **Cartelle** nei corsi (dal vecchio Drive o scelte al caricamento) come filtri, e **ordinamento**
  (più recenti, più aperti, più votati, nome).
- **Avviso doppioni** se si carica un file con lo stesso nome e dimensione di uno già presente.
- **App sul telefono**: menu utente → "Installa l'app sul telefono" (Android: installazione diretta;
  iPhone/iPad: Condividi → Aggiungi alla schermata Home).
- **Tema scuro** automatico se il dispositivo è in modalità scura.
- **Tour di benvenuto** al primo accesso (avviabile anche da Amministrazione).
- In Amministrazione: **statistiche** degli ultimi 7 giorni, file più aperti e corsi più usati.

## Pagina Rappresentanti

Contatti dei rappresentanti e link utili (siti, app, corso sicurezza, esami scoglio, ecc.).
I dati stanno nel database e sono visibili **solo agli studenti che hanno fatto l'accesso**:
i contatti personali non compaiono mai nel codice pubblico. Gli amministratori li modificano
direttamente dalla pagina (pulsanti *Aggiungi*, matita e cestino).

## Pagina Professori

Elenco dei docenti (62, da *informazioni_professori, aprile 2026*): una riga compatta per docente
che si apre con un tocco mostrando email, ruoli, corsi, ambito e gruppo di ricerca, dipartimento e
formazione. Ricerca istantanea (nome, corso, ricerca, gruppo) e filtro per dipartimento.
Visibile solo agli studenti loggati; gli amministratori possono aggiungere, modificare ed eliminare.
I dati iniziali si caricano una volta con [`supabase/professori.sql`](supabase/professori.sql)
(SQL Editor → Run; non crea doppioni se rieseguito).

## Classifica e moderazione

**Classifica a leghe** (menu *Classifica*): Ferro, Bronzo, Argento, Oro, Platino, Smeraldo e
Diamante con 4 divisioni ciascuna; sopra i 1000 punti Maestro, Gran Maestro (posizioni 2–5) e
Sfidante (n° 1). Gli stemmi sono disegni originali.
- **+10** punti per file caricato (max 10 file al giorno)
- **+5** quando un altro studente apre un tuo file (una volta per ogni studente)
- **+1** per ogni file di altri che apri per la prima volta (max 5 punti al giorno)
- **−10** se un amministratore elimina un tuo file (la pulizia automatica e l'eliminazione di un corso non tolgono punti)

**Moderazione**
- Ogni studente può **segnalare** un file inappropriato; le segnalazioni compaiono in *Amministrazione*
  con i pulsanti *Elimina file*, *Sospendi autore*, *Ignora*.
- Gli amministratori possono **sospendere** un utente indicando il motivo (ed eliminare tutti i suoi file).
  L'utente sospeso non vede più nulla e trova la pagina "Account sospeso"; si può riattivare in ogni momento.
  Gli amministratori non sono sospendibili finché non viene revocato il ruolo.

## Limiti del piano gratuito
- Spazio per i file: circa **1 GB** in totale; ogni file al massimo **50 MB**.
- Se nessuno usa il sito per **7 giorni**, Supabase mette in pausa il progetto: i dati restano,
  si riattiva con un clic dalla dashboard di Supabase.
- Lo spazio usato è visibile nella pagina **Amministrazione**.

## Domande frequenti
**Google dice "app bloccata" o "accesso negato"?** L'Ateneo potrebbe bloccare le app esterne
sugli account campus. Si può passare all'accesso con link via email istituzionale.

**Un utente con Gmail personale può entrare?** No: il database rifiuta qualunque account che non
sia `@campus.unimib.it`, anche se qualcuno modificasse il sito.

**Cambiare nome, testo a piè di pagina o limite dei file?** Sono tutti in `docs/config.js`.

---

## Per chi sviluppa
```
docs/            il sito (HTML, CSS, JavaScript) pubblicato da GitHub Pages
  config.js      impostazioni
  js/api.js      accesso a Supabase (+ modalità anteprima)
  js/app.js      pagine e interfaccia
supabase/
  setup.sql      tabelle, permessi (Row Level Security) e archivio file
  functions/b2/  funzione che firma i link di caricamento/scaricamento (Backblaze B2 e Cloudflare R2)
  tests/         test dei permessi su PostgreSQL locale: sh supabase/tests/run.sh
drive-import/    inventario.gs e importa.gs (script Google), robot.py (compressione, GitHub Actions)
.github/workflows/robot.yml   robot che comprime le registrazioni ogni ora
Test della funzione B2: node --experimental-strip-types --test supabase/functions/b2/test/*.test.ts
```
I permessi sono imposti dal database (Row Level Security), non dall'interfaccia.

Dopo ogni modifica a CSS/JS aggiorna il numero di versione in tre punti: i `?v=` e `data-v`
in `docs/index.html` e `VERSION` in `docs/js/app.js`. Se un browser tiene in memoria una pagina
vecchia, il sito se ne accorge e si ricarica da solo.

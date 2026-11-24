# Prompt per l'agente: collegare un provider e importare le sue repo

Sei un agente che lavora nel repository Cobalt (cobaltforge). Devi implementare, in fasi, il collegamento a provider Git esterni e l'importazione delle loro repo, partendo da GitHub. Parla con me in italiano. Scrivi codice, commenti, messaggi d'errore, documentazione e test in inglese, come nel resto del repo.

## Prima di toccare il codice

Leggi, in quest'ordine: `CLAUDE.md`, `packages/api/README.md`, `apps/web/src/lib/effect/README.md`, `convex/_generated/ai/guidelines.md`. Le regole lì sovrastano ciò che sai di Convex ed Effect. Il codice server asincrono si scrive con Effect (v4); componenti e `convex/` non lo usano. Importa un altro pacchetto per nome (`@cobaltforge/api/auth`), mai con un percorso relativo. Un cambio all'API HTTP è solo additivo e richiede `bun scripts/api-snapshot.ts`, `bun scripts/api-docs.ts` e `bun scripts/api-sdk.ts`. Da root: `bun run check`, `bun run build`, `bun test`.

## Regole che non si negoziano

- **Non chiedere mai le credenziali di Code.Storage o della GitHub App.** Sono già su Railway. Si usano con `railway run -- <comando>`, che le inietta nel processo senza scriverle su disco. Il progetto è `cobaltforge` (id `863d4a12-07a4-4866-a050-6bc6a8d77385`), ambiente `production`, servizio `web`. In un worktree nuovo esegui una volta `railway link -p 863d4a12-07a4-4866-a050-6bc6a8d77385 -e production -s web`. La CLI è già autenticata. Le variabili che servono sono `PIERRE_ORG`, `PIERRE_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`.
- **Non stampare, loggare o committare mai un valore segreto.** Verifica la presenza di una variabile senza mostrarla (`[ -n "$VAR" ]`).
- **Il probe può creare e cancellare solo repo il cui nome inizia con `cobalt-probe-`**, sull'account GitHub `JustMarkDev` e nell'organizzazione Code.Storage di produzione. Lo script deve rifiutarsi di cancellare qualunque altro nome. `gh` è già collegato con gli scope `repo` e `delete_repo`.
- **Non fare commit, push né pull request** a meno che l'utente lo chieda.
- **Non installare strumenti di sistema** (brew, binari) senza il consenso esplicito dell'utente.
- **Fermati alla fine di ogni fase** e riferisci: cosa hai fatto, cosa hai verificato davvero, cosa no. Se un test fallisce, riporta l'errore esatto. Non dire "fatto" per ciò che non hai eseguito.
- Chiedi all'utente solo ciò che solo lui può fare (vedi "Azioni solo dell'utente"). Il resto lo decidi tu e lo scrivi nel rapporto.

## Contesto e stato verificato

Una repo Cobalt è collegata a **un solo provider**, e il sync avviene solo tra quei due. Il provider è l'autorità per rami e tag e per lo stato di PR e issue. Cobalt non unisce mai due provider.

Come funziona oggi (verificato leggendo il codice):

- `packages/api/src/github.ts` fa solo login GitHub (device flow e OAuth nel browser) e prova che l'utente può pushare. Il token vive in un blob sigillato per 10 minuti e non si salva.
- `packages/api/src/domain/convex.ts:importRepo` importa una repo alla volta: autorizza, crea la repo con `upstream`, la reclama in `githubLinks`, aggiunge un mirror.
- `packages/git/src/stores.ts` (`GitStores.provision/pull/detach`) chiama Code.Storage con `provider: 'github'` fisso.
- `convex/forge/upstreams.ts:recordSync` registra gli eventi `repo.sync.*` ma cerca `host === 'github'`.
- I push passano da un proxy git di Cobalt (`packages/api/src/git-http.ts`) che crea un token Code.Storage per richiesta.
- Lo schema ha già `repos.upstream.host` con gitlab, codeberg, gitea, ma `importRepo` rifiuta ogni host diverso da GitHub. `links` è l'identità verificata dell'account. `connections` serve alle chiavi di integrazione: non riusarla. `actorRef` (`{id, handle, class}`) punta ad account Cobalt. Le PR hanno già `mirrors: {host, number, origin: 'here'|'there'}`.
- Non esiste nessuna route `/hooks/github`. Non c'è codice che importi PR, issue o release: l'import oggi porta solo git.

Come funziona Code.Storage (documentazione `code.storage/docs`):

- `repos.create({upstream})` collega la repo a un upstream. Se ne ha già uno risponde `409 upstream_already_configured`. Il provider è l'autorità: ogni push al remote Code.Storage viene inoltrato al provider e poi le modifiche tornano indietro. Si sincronizzano solo `refs/heads`, tag e `refs/notes/*`.
- GitHub: modalità App (token di installazione creati da Code.Storage con la chiave dell'App, LFS supportato). Gli altri host (gitlab, codeberg, gitea, forgejo, bitbucket, sr.ht): modalità generic, con `repos.gitCredentials.create` (un token HTTPS salvato per repo), senza LFS. Per gli host generic non è documentato come Code.Storage senta le modifiche: considera che serva `repos.upstream.pull`.
- Durante il primo sync le chiamate rispondono `409 sync_in_progress`. Gli errori elencati includono `github_app_not_configured` (412) e `credential_exists` (409).
- Il probe ha già verificato che l'App funziona: `repos.create` con upstream GitHub accettato in 0,8 s, primo sync con `main` dopo 2,6 s, repo di prova cancellati. Lo script è `packages/git/probe/smoke.ts` e si lancia con `railway run -- bun packages/git/probe/smoke.ts`.

La GitHub App "Cobalt Forge Sync" (id 5907806): installata su JustMarkDev su tutti i repository; permessi `contents`, `issues`, `pull_requests` in scrittura, `metadata` in lettura. **Manca `workflows`, e non è sottoscritto nessun evento.** L'URL del webhook è `https://cobaltforge.dev/hooks/github`, dove non c'è ancora nessuna route.

## Decisioni prese

- **Git per tutti passa da Code.Storage.** GitHub in modalità App, gli altri in modalità generic. Non scriviamo un motore di sync.
- **Provider v1:** github.com, gitlab.com, codeberg.org. Un'app OAuth ciascuno. Niente istanze self-hosted.
- **Collegamento con OAuth una volta sola.** Il rinnovo è silenzioso e pigro: prima di ogni push inoltrato o pull, solo per la repo coinvolta, serializzato (GitLab ruota il refresh token a ogni uso).
- **Rilevamento delle modifiche:** su GitHub il webhook dell'App punta a Cobalt, non a Code.Storage, e Cobalt chiama `upstream.pull`. Sugli altri provider si crea un webhook per progetto solo sulle repo importate. Fallback: pull pigro con TTL quando qualcuno apre o scarica la repo, più un cron lento.
- **Gli accessi li decide Cobalt.** Un collaboratore con permesso di scrittura qui può pushare anche se il provider glielo vieta. L'utente va avvisato all'import.
- **GitLab: scope OAuth `api`**, per creare i webhook. Il token salvato per ogni repo è molto potente: cifrato a riposo e cancellato alla disconnessione.
- **PR, issue e release prima in sola lettura.** Gli autori esterni si salvano come snapshot, non come account Cobalt.

## Fuori dalla v1

Scrittura di PR e issue sul provider, trasformare le PR da fork in veri branch su Cobalt, import delle regole di branch protection, istanze self-hosted, Bitbucket, account bot o token di gruppo.

## Fase 0: probe di Code.Storage

Obiettivo: rispondere ai rischi aperti (tabella in fondo) con script che girano da soli, prima di costruire. Sostituisce `scripts/code-storage-probe.ts`.

Come costruirlo:

- Cartella `packages/git/probe/` (lì l'SDK `@pierre/sdk` si risolve): un runner (`railway run -- bun packages/git/probe/run.ts --only github`) e un file per scenario. Parti da `smoke.ts`. Un remote git autenticato di Code.Storage si ottiene come fa `packages/git/src/remote.ts`.
- Ogni scenario scrive esito, tempi e il **messaggio d'errore esatto** in `docs/plans/probe-results.md`, con la conseguenza per la riga corrispondente della tabella dei rischi.
- Repo di prova `cobalt-probe-<timestamp>`, cancellati sempre, anche se lo scenario fallisce (`--keep` per tenerli). Attese con polling e timeout, mai passi manuali.

Scenari GitHub (tutti automatici):

1. Creazione con `upstream`: tempo del primo sync e comportamento durante `sync_in_progress`.
2. GitHub verso Code.Storage con `upstream.pull`: latenza.
3. Code.Storage verso GitHub con un push sul remote: arrivo e latenza.
4. **Divergenza:** GitHub avanza, poi si pusha su Code.Storage senza pull. Esito, errore, messaggio. Non sappiamo se il push è rifiutato o se sovrascrive.
5. Force push su GitHub e su Code.Storage: l'altro lato segue?
6. Cancellazione di branch e tag in entrambe le direzioni.
7. Branch protection su GitHub (su un repo **pubblico**, i privati gratuiti non la hanno): un push da Code.Storage che la viola, errore ricevuto.
8. Rename del repo su GitHub: cosa succede al pull successivo.
9. Repo grande (usa un repo pubblico noto con la modalità `access: 'public'` o uno tuo): tempo del primo sync.
10. PR chiusa con branch cancellato: lo SHA di testa esiste in Code.Storage (`commits.get`)? Scarica la patch via API GitHub e ricreala con `repos.commits.createFromDiff` su un branch effimero.
11. LFS in modalità App: push di un file LFS da Code.Storage e verifica su GitHub.

Scenari generic su un Forgejo locale (stessa famiglia di Codeberg): richiedono Forgejo (binario o brew) e `cloudflared` (tunnel rapido senza account), che **non sono installati** e Docker non c'è. **Prima di installare qualsiasi cosa chiedi il consenso all'utente**, dopo aver finito gli scenari GitHub.

1. Creazione generic più `gitCredentials.create`: primo sync.
2. Pull dopo un push sul provider, senza webhook: latenza.
3. Push inoltrato da Code.Storage, divergenza, force push, cancellazione.
4. Token come password git: PAT contro token OAuth. Scadenza accorciata nella config locale e `gitCredentials.update` a metà sync.
5. Webhook a livello utente e organizzazione: scatta per tutte le repo? Verifica di firma HMAC e UUID di consegna.

In pausa, **non farli**: GitLab (istanza locale troppo pesante, account gitlab.com da aprire), Codeberg reale, PR da fork (serve un secondo account GitHub), rate limit reali. Le parti del piano che ne dipendono restano "non verificato".

Uscita della fase: ogni riga della tabella dei rischi diventa "verificato" o "piano B attivo". Se un risultato contraddice un'assunzione delle fasi successive (per esempio un push dopo divergenza sovrascrive in silenzio), **fermati e dimmelo prima di proseguire**: il piano va rivisto.

## Fase 1: fondamenta, nessun cambio visibile

1. **Schema** (`convex/schema.ts`, migrazione con `@convex-dev/migrations`):
   - `providerConnections`: account, provider, istanza, id esterno e login, token e refresh token cifrati, scadenza, scope, stato (`ok` o `needs_reconnect`).
   - `remoteRepos`: provider, istanza, id esterno (indice univoco), nome completo, `repoId`, `connectionId`, stato, id e secret del webhook, flag LFS, snapshot dei metadati, ultimo sync. Sostituisce `githubLinks` (backfill poi rimozione).
   - `externalActors`: provider, id esterno, login, nome, avatar, flag cancellato.
   - `importJobs` e `importItems`: progresso di un import in blocco.
2. **Interfaccia `ForgeProvider`** in `packages/api/src/forge/`: elenco repo paginato, lettura repo, credenziale git, registrazione e rimozione webhook, lettura e verifica dei webhook, `capabilities`.
3. **Adapter GitHub** estratto da `packages/api/src/github.ts`.
4. **`GitStores`**: `provision` prende provider, host, owner, nome. Aggiungi `setCredential`, `updateCredential`, `deleteCredential`, e lo stesso nel fake (`packages/git/src/fake.ts`).
5. **Togliere i punti solo-GitHub:** `importRepo` (`domain/imports.ts`, `domain/convex.ts`), `recordSync`, `upstreamProblem`.
6. **Cifratura a riposo** con AES-GCM e id della chiave, per poter ruotare.

Uscita: tutto come prima, GitHub passa dall'interfaccia, suite e snapshot API invariati.

## Fase 2: GitHub completo

1. **Webhook su Cobalt:** route `/hooks/github`. Verifica `x-hub-signature-256`, deduplica su `x-github-delivery`. Il `push` chiama `upstream.pull`. Gli eventi `installation`, `installation_repositories` e `repository` aggiornano `remoteRepos` (rename, archivio, cancellazione, visibilità). Le variabili dell'App sono su Railway nel servizio `web`, non nell'env di Convex: decidi dove vive il ricevitore (app web, dove esistono già, oppure `convex/http.ts` aggiungendole a `convex/convex.config.ts`) e scrivi la scelta nel rapporto.
2. **Installation token:** firma un JWT con la private key dell'App e scambialo, con cache breve.
3. **Elenco dalle installation**, non dal token utente, senza il limite di 10 pagine. Il token utente resta solo per provare identità e permesso di push.
4. **Import in blocco:** selettore con ricerca, "seleziona tutte", filtri fork e archiviate. Un job con `@convex-dev/workflow` (da installare), concorrenza limitata, retry sul `409 sync_in_progress`, avanzamento con query reattiva, `authorize` una volta per lotto.
5. **Metadati della repo** nei campi già presenti (`stars`, `forks`, `license`, `website`, `languages`), aggiornati dal webhook `repository`.
6. **Pull pigro con TTL** nel proxy git e cron lento sulle repo recenti.
7. Aggiorna `apps/web/content/docs/getting-started/import-and-mirrors.mdx` e rigenera snapshot, doc e SDK.

## Fase 3: GitLab e Codeberg

Non puoi verificare nulla contro i provider veri (servono account dell'utente). Costruisci tutto contro fake e test, e segna ogni verifica reale come "non verificata".

1. App OAuth su gitlab.com e codeberg.org, variabili d'ambiente (la registrazione dell'app OAuth la fa l'utente).
2. Route di callback in `apps/web/src/routes/<provider>/callback.tsx`, modellate su `github/callback.tsx`, con `state` firmato.
3. **Rinnovo:** mutation che serializza il refresh. Chiamata prima di ogni push inoltrato e pull. Un fallimento porta a `needs_reconnect`.
4. **Adapter GitLab e Forgejo:** elenco repo paginato, lettura repo, creazione e rimozione del webhook per repo con secret derivato (HMAC di un segreto maestro con l'id della repo), verifica (token in chiaro su GitLab, HMAC su Forgejo, deduplica per UUID).
5. **Import:** `provision` con upstream, `gitCredentials.create` (o `update` se `credential_exists`), creazione del webhook. Se il webhook non si può creare (ruolo insufficiente), la repo resta con "aggiornamento ritardato".
6. **Avviso LFS** se `.gitattributes` usa `filter=lfs`.
7. **Disconnessione:** revoca il token, cancella le credenziali in Code.Storage, rimuove i webhook, stacca le repo.
8. **Adozione:** un admin della repo con una propria connessione valida riprende il collegamento.

## Fase 4: PR, issue, release in sola lettura

1. Attore esterno: aggiungi un tipo basato su `externalActors` accanto a `actorRef`, in modo additivo.
2. Stati delle PR: aperta, chiusa, unita, bozza verso `open`, `abandoned`, `landed`, `draft`, passando dalle mosse di `lifecycles.ts`. Usa il campo `mirrors` (`origin: 'there'`).
3. Import iniziale come job, poi incrementale con webhook (`pull_request`, `issues`, `release`, commenti), richieste condizionali con ETag e rispetto dei limiti di rate.
4. **Patch delle PR i cui commit non sono nella repo** (PR aperte da fork, PR chiuse senza merge con il branch cancellato): si riconoscono controllando se lo SHA di testa esiste in Code.Storage. Per quelle sole scarica la patch dall'API del provider (`.diff` e `.patch` su GitHub e Forgejo, `changes` su GitLab) e salvala come testo con la PR. Ricreare la patch come branch effimero con `createFromDiff` è un'idea da provare dopo, solo se il probe 10 ha funzionato.
5. Cancellazioni sul provider: "rimosse sul provider", con l'autore se l'evento lo porta.
6. Nuove operazioni solo additive (`ops/imports.ts`), con snapshot, doc, SDK.

## Fase 5: chiusura dei bordi

1. `convex/deletion.ts`: alla cancellazione di un account, revoca i token, cancella credenziali e webhook, decidi le repo che dipendevano da quella persona.
2. Avviso sugli accessi all'import e nelle impostazioni della repo.
3. Errore chiaro quando un push fallisce per un collegamento morto, con indicazione di chi può riconnettere.
4. Log di audit per connessioni, adozioni e scollegamenti.
5. CLI: `cb import gitlab` e `cb import codeberg`. Docs.

## Rischi aperti (non verificati)

| Rischio                                                                                 | Dove si verifica                             | Piano B                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Un push dopo che il provider si è mosso viene rifiutato in modo poco chiaro             | Fase 0, GitHub 4 e Forgejo 3                 | Tradurre l'errore, avvisare l'utente                       |
| Force push e cancellazione di branch non si propagano in una delle due direzioni        | Fase 0, GitHub 5 e 6                         | Documentarlo, pull manuale                                 |
| Rename o transfer su GitHub rompe `owner/name` dell'upstream in Code.Storage            | Fase 0, GitHub 8 (rename). Transfer in pausa | Aggiornare l'upstream dal webhook `repository`, o ricreare |
| Una regola di protezione del provider respinge il push inoltrato senza un errore chiaro | Fase 0, GitHub 7                             | Tradurre l'errore, mostrare la regola violata              |
| Il token OAuth non funziona come password git su Forgejo e Codeberg                     | Fase 0, Forgejo 4. Codeberg reale in pausa   | Token incollato dall'utente solo per quel provider         |
| Un hook utente o org di Forgejo non scatta per tutte le repo                            | Fase 0, Forgejo 5                            | Hook per repo come su GitLab                               |
| La creazione di webhook su GitLab richiede un ruolo che l'utente non ha                 | In pausa                                     | Pull pigro e cron                                          |
| Il refresh token scade o viene rifiutato                                                | Fase 0, Forgejo 4. GitLab in pausa           | `needs_reconnect` e riconnessione                          |
| Rate limit dei provider durante un import grande                                        | In pausa                                     | Concorrenza bassa, ETag, coda                              |
| Le PR da fork non hanno commit né patch recuperabili                                    | In pausa                                     | Link al provider                                           |

## Azioni solo dell'utente

Chiedile quando servono, una per volta e con le istruzioni esatte:

- Nelle impostazioni della GitHub App su github.com: sottoscrivere gli eventi (`push`, `installation`, `installation_repositories`, `repository`, `pull_request`, `issues`, `release`), aggiungere il permesso `workflows`, e puntare l'URL del webhook alla route che crei in Fase 2. Non esiste un'API per farlo.
- Registrare le app OAuth su gitlab.com e codeberg.org (Fase 3).
- Consenso per installare strumenti (Forgejo, `cloudflared`).

## Come lavorare

1. Parti dalla Fase 0 e fermati a fine fase con un rapporto: scenari eseguiti con esito e tempi, errori esatti, righe della tabella dei rischi aggiornate, cosa cambia nelle fasi dopo.
2. Una fase alla volta, con test. `bun run check`, `bun run build` e `bun test` devono passare prima di dichiarare una fase finita. Per le funzioni Convex usa anche i test Convex del repo se esistono.
3. Se qualcosa nel piano non torna con il codice reale, dillo e proponi la correzione. Non seguire il piano alla lettera contro i fatti.

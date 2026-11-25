# Piano: collegare un provider e importare le sue repo

Una repo qui è collegata a **un solo provider**, e il sync avviene solo tra quei due. Il provider è l'autorità per rami e tag e per lo stato di PR e issue. Cobalt non unisce mai due provider.

Prima di toccare il codice leggere: `packages/api/README.md`, `apps/web/src/lib/effect/README.md` e `convex/_generated/ai/guidelines.md`. Le dimensioni (S, M, L) sono stime a occhio, non misurate.

## Decisioni prese

- **Git per tutti passa da Code.Storage.** GitHub in modalità App, gli altri in modalità generic (token HTTPS salvato per repo). Non scriviamo un motore di sync.
- **Provider v1:** github.com, gitlab.com, codeberg.org. Un'app OAuth ciascuno. Niente istanze self-hosted.
- **Collegamento con OAuth una volta sola.** Il rinnovo è silenzioso. Il token si rinnova in modo pigro: prima di ogni push inoltrato o pull, solo per la repo coinvolta.
- **Rilevamento delle modifiche:** su GitHub il webhook dell'App punta a Cobalt (non a Code.Storage) e Cobalt chiama `upstream.pull`. Sugli altri provider si crea un webhook per progetto solo sulle repo importate. Fallback: pull pigro con TTL quando qualcuno apre o scarica la repo, più un cron lento.
- **Gli accessi li decide Cobalt.** Un collaboratore con permesso di scrittura qui può pushare anche se il provider glielo vieta. L'utente va avvisato all'import e deve replicare le sue regole su Cobalt.
- **GitLab: chiediamo lo scope `api`.** Serve a creare i webhook. È uno scope ampio, quindi il token salvato per ogni repo può fare molto: va cifrato e cancellato alla disconnessione.
- **Il probe entra nel piano (Fase 0), il più automatico possibile.** I passaggi che richiedono di aprire account o dare credenziali di altri provider restano in pausa. GitHub si può fare, perché `gh` è già collegato.
- **PR, issue e release prima in sola lettura.** Gli autori esterni si salvano come snapshot, non come account Cobalt.

## Fuori dalla v1

Scrittura di PR e issue sul provider, trasformare le PR da fork in veri branch su Cobalt (vedi Fase 4, punto 4), import delle regole di branch protection, istanze self-hosted, Bitbucket, account bot o token di gruppo.

## Fase 0: probe di Code.Storage, il più automatico possibile (M)

Obiettivo: rispondere ai rischi aperti in fondo con script che girano da soli, prima di costruire. Sostituisce `scripts/code-storage-probe.ts`, che copre solo tre scenari.

- Cartella `packages/git/probe/`: un runner (`bun packages/git/probe/run.ts --only github`) e un file per scenario.
- Ogni scenario scrive esito, tempi e il messaggio d'errore esatto in `docs/plans/probe-results.md`.
- I repo di prova si chiamano `cobalt-probe-<timestamp>` e si cancellano sempre, anche se lo scenario fallisce (`--keep` per tenerli).
- Le attese (sync, propagazione) sono polling con timeout, mai passi manuali. Non do una stima di tempo: la parte lunga è aspettare i sync.

**Cosa serve da te, solo GitHub:**

1. **Credenziali Code.Storage: nessuna, non si chiedono più.** `PIERRE_ORG` e `PIERRE_PRIVATE_KEY` sono già nel servizio `web` (produzione) del progetto Railway `cobaltforge`, insieme a `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` e `GITHUB_APP_WEBHOOK_SECRET`. Il probe parte con `railway run -- bun packages/git/probe/run.ts`: Railway inietta le variabili nel processo e non si scrive nulla su disco. Il link della CLI (`railway link -p 863d4a12-07a4-4866-a050-6bc6a8d77385 -e production -s web`) è già fatto per questa cartella. Un'altra cartella o worktree richiede lo stesso comando una volta. Il probe usa l'organizzazione di produzione e crea solo repo con prefisso `cobalt-probe-`, che cancella a fine corsa.
2. `gh` è collegato come JustMarkDev con gli scope `repo` e `delete_repo` (fatto).
3. La GitHub App è configurata in Code.Storage e installata sul tuo account su tutti i repository (fatto).

**Stato (primo smoke test, `packages/git/probe/smoke.ts`):**

- La GitHub App "Cobalt Forge Sync" funziona: chiave valida, installata sul tuo account su tutti i repository (20 raggiungibili), permessi `contents`, `issues`, `pull_requests` in scrittura e `metadata` in lettura. Manca il permesso `workflows` (un push che tocca `.github/workflows/` verrebbe rifiutato).
- **Nessun evento è sottoscritto** nell'App, e l'URL del webhook è `https://cobaltforge.dev/hooks/github`, dove oggi non c'è nessuna route. Serve per la Fase 2.
- **Sbloccato:** l'App è stata configurata nella dashboard Code.Storage. Lo smoke test passa: `repos.create` con upstream GitHub accettato in 0,8 s, primo sync con il branch `main` dopo 2,6 s, repo di prova cancellati su entrambi i lati.

**Scenari GitHub (automatici con quanto sopra):**

1. Creazione con `upstream`: tempo del primo sync e comportamento durante `sync_in_progress`.
2. GitHub verso Code.Storage con `upstream.pull`: latenza.
3. Code.Storage verso GitHub con un push sul remote: arrivo e latenza.
4. **Divergenza:** GitHub avanza, poi si pusha su Code.Storage senza pull. Esito, errore, messaggio.
5. Force push su GitHub e su Code.Storage: l'altro lato segue?
6. Cancellazione di branch e tag in entrambe le direzioni.
7. Branch protection su GitHub (su un repo pubblico, perché i privati gratuiti non la hanno): push da Code.Storage che la viola, errore ricevuto.
8. Rename del repo su GitHub: cosa succede al pull successivo.
9. Repo grande: tempo del primo sync.
10. PR chiusa con branch cancellato: lo SHA di testa esiste in Code.Storage? Scaricare la patch via API e ricrearla con `commits.createFromDiff` su un branch effimero.
11. LFS in modalità App: push di un file LFS da Code.Storage e verifica su GitHub.

**Scenari generic su un Forgejo locale (automatici dopo aver installato due strumenti):** Forgejo come binario o via brew (da verificare quale funziona su macOS) e `cloudflared` (tunnel rapido senza account) per renderlo raggiungibile da Code.Storage. Docker non c'è su questa macchina. Si installa solo con il tuo ok. Forgejo è lo stesso software di Codeberg.

1. Creazione generic più `gitCredentials.create`: primo sync.
2. Pull dopo un push sul provider, senza webhook: latenza.
3. Push inoltrato da Code.Storage, divergenza, force push, cancellazione.
4. **Token come password git:** PAT contro token OAuth. Scadenza accorciata nella config locale e `gitCredentials.update` a metà sync.
5. Webhook a livello utente e organizzazione: scatta per tutte le repo? Verifica di firma HMAC e UUID di consegna.

**In pausa (richiedono account o azioni tue):**

- GitLab: istanza locale troppo pesante, account gitlab.com da aprire.
- Codeberg reale.
- PR da fork, che richiedono un secondo account GitHub.
- Rate limit reali dei provider.

Le parti del piano che dipendono da questi punti restano marcate "non verificato" fino a quando decidi di farli.

Uscita: ogni riga della tabella dei rischi diventa "verificato" o "piano B attivo".

## Fase 1: fondamenta, nessun cambio visibile (M)

1. **Schema** (`convex/schema.ts`, migrazione con `@convex-dev/migrations`):
   - `providerConnections`: account, provider, istanza, id esterno e login, token e refresh token cifrati, scadenza, scope, stato (`ok` o `needs_reconnect`). La tabella `connections` esistente serve alle chiavi di integrazione: non toccarla. `links` resta l'identità verificata.
   - `remoteRepos`: provider, istanza, id esterno (indice univoco), nome completo, `repoId`, `connectionId`, stato, id e secret del webhook, flag LFS, snapshot dei metadati, ultimo sync. Sostituisce `githubLinks` (backfill poi rimozione).
   - `externalActors`: provider, id esterno, login, nome, avatar, flag cancellato.
   - `importJobs` e `importItems`: progresso di un import in blocco.
2. **Interfaccia `ForgeProvider`** in `packages/api/src/forge/`: elenco repo paginato, lettura repo, credenziale git, registrazione e rimozione webhook, lettura e verifica dei webhook, `capabilities`.
3. **Adapter GitHub** estratto da `packages/api/src/github.ts` (oggi mescola sigillatura dei token, OAuth ed elenco).
4. **`GitStores`** (`packages/git/src/stores.ts`): `provision` prende provider, host, owner, nome. Aggiungere `setCredential`, `updateCredential`, `deleteCredential`, e lo stesso nel fake.
5. **Togliere i punti solo-GitHub:** `importRepo` (`domain/imports.ts`, `domain/convex.ts`), `recordSync` (`convex/forge/upstreams.ts`, cerca `host === 'github'`), `upstreamProblem`.
6. **Cifratura a riposo** con AES-GCM e id della chiave, per poter ruotare.

Uscita: tutto come prima, GitHub passa dall'interfaccia, suite e snapshot API invariati.

## Fase 2: GitHub completo (L)

1. **Webhook su Cobalt:** route `/hooks/github` in `convex/http.ts`. Verifica `x-hub-signature-256`, deduplica su `x-github-delivery`. Il `push` chiama `upstream.pull`. Gli eventi `installation`, `installation_repositories` e `repository` aggiornano `remoteRepos` (rename, archivio, cancellazione, visibilità). Le variabili dell'App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`) sono già su Railway, nel servizio `web`, non nell'env di Convex. Decidere dove vive il ricevitore: nell'app web, dove le variabili esistono già, oppure in `convex/http.ts` aggiungendole a `convex/convex.config.ts`. Poi spostare l'URL del webhook dell'App e togliere il secret dalla dashboard Code.Storage.
2. **Installation token:** firmare un JWT con la private key (una seconda chiave dedicata a Cobalt) e scambiarlo, con cache breve.
3. **Elenco dalle installation**, non dal token utente, senza il limite di 10 pagine. Il token utente resta solo per provare identità e permesso di push.
4. **Import in blocco:** selettore con ricerca, "seleziona tutte", filtri fork e archiviate. Un job con il componente `@convex-dev/workflow` (da installare), concorrenza limitata, retry sul `409 sync_in_progress`, avanzamento con query reattiva, `authorize` una volta per lotto.
5. **Metadati della repo** nei campi già presenti (`stars`, `forks`, `license`, `website`, `languages`), aggiornati dal webhook `repository`.
6. **Pull pigro con TTL** nel proxy git (`packages/api/src/git-http.ts`) e cron lento sulle repo recenti.
7. Aggiornare `import-and-mirrors.mdx`, poi `bun scripts/api-snapshot.ts`, `api-docs.ts`, `api-sdk.ts`.

## Fase 3: GitLab e Codeberg (L)

**Deciso:** su GitLab chiediamo lo scope `api` per creare i webhook. Va verificato, quando si potrà provare GitLab, che sia davvero quello richiesto e che basti il ruolo dell'utente sul progetto.

1. App OAuth registrate su gitlab.com e codeberg.org, variabili d'ambiente.
2. Route di callback in `apps/web/src/routes/<provider>/callback.tsx`, modellate su `github/callback.tsx`, con `state` firmato.
3. **Rinnovo:** mutation che serializza il refresh (GitLab ruota il refresh token a ogni uso). Chiamata prima di ogni push inoltrato e pull. Un fallimento porta a `needs_reconnect`.
4. **Adapter GitLab e Forgejo:** elenco repo paginato, lettura repo, creazione e rimozione del webhook per repo con secret derivato (HMAC di un segreto maestro con l'id della repo), verifica (token in chiaro su GitLab, HMAC su Forgejo, deduplica per UUID).
5. **Import:** `provision` con upstream, `gitCredentials.create` (o `update` se `credential_exists`), creazione del webhook. Se il webhook non si può creare (ruolo insufficiente), la repo resta con "aggiornamento ritardato".
6. **Avviso LFS** se `.gitattributes` usa `filter=lfs` (la generic sync non supporta LFS).
7. **Disconnessione:** revoca il token, cancella le credenziali in Code.Storage, rimuove i webhook, stacca le repo.
8. **Adozione:** un admin della repo con una propria connessione valida riprende il collegamento.

## Fase 4: PR, issue, release in sola lettura (L)

1. Attore esterno: oggi `actorRef` (`{id, handle, class}`) punta a un account Cobalt. Aggiungere un tipo esterno basato su `externalActors`, in modo additivo.
2. Stati delle PR: aperta, chiusa, unita, bozza verso `open`, `abandoned`, `landed`, `draft`, passando dalle mosse di `lifecycles.ts`. Usare il campo `mirrors` esistente (`origin: 'there'`).
3. Import iniziale come job, poi incrementale con webhook (`pull_request`, `issues`, `release`, commenti), richieste condizionali con ETag e rispetto dei limiti di rate.
4. **Diff e patch delle PR i cui commit non sono nella repo** (PR aperte da fork, PR chiuse senza merge con il branch cancellato). Si riconoscono controllando se lo SHA di testa esiste in Code.Storage (`getCommit` risponde 404). Per quelle sole, un'unica chiamata all'API del provider scarica la patch (`.diff` e `.patch` su GitHub e Forgejo, `changes` sulle merge request di GitLab) e la salviamo come testo insieme alla PR. Così diff e file modificati si vedono sempre. Le PR unite e quelle dello stesso repo non servono: i commit sono già in git.
   Da provare dopo: ricreare quella patch come commit su un branch effimero con `repos.commits.createFromDiff` di Code.Storage (resta solo su Cobalt, non arriva al provider), per avere la PR come branch vero.
5. Cancellazioni sul provider: segnate come "rimosse sul provider", con l'autore se l'evento lo porta.
6. Nuove operazioni solo additive (`ops/imports.ts`), con snapshot, doc, SDK.

## Fase 5: chiusura dei bordi (M)

1. `convex/deletion.ts`: alla cancellazione di un account, revocare i token, cancellare credenziali e webhook, decidere le repo che dipendevano da quella persona.
2. Avviso sugli accessi all'import e nelle impostazioni della repo.
3. Errore chiaro quando un push fallisce per un collegamento morto, con indicazione di chi può riconnettere.
4. Log di audit per connessioni, adozioni e scollegamenti.
5. CLI: `cb import gitlab` e `cb import codeberg`. Docs.

## Rischi aperti

La colonna "Dove si verifica" dice quale scenario della Fase 0 lo copre. "In pausa" significa che richiede account o azioni tue e resta non verificato. Ogni riga ha un piano B. Lo stato viene da `docs/plans/probe-results.md` (corse del 2026-11-24).

| Rischio                                                                                 | Dove si verifica                                         | Stato                                                                                                                                                                                                                                                     | Piano B                                                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Un push dopo che il provider si è mosso viene rifiutato in modo poco chiaro             | Fase 0, GitHub 4 e Forgejo 3                             | Verificato su GitHub e Forgejo. Rifiutato con `! [rejected] HEAD -> main (fetch first)`, nulla sovrascritto                                                                                                                                               | Tradurre l'errore, avvisare l'utente                         |
| Force push e cancellazione di branch non si propagano in una delle due direzioni        | Fase 0, GitHub 5 e 6                                     | GitHub: verificato. Si propagano in entrambe le direzioni (verso lo store dopo `upstream.pull`)                                                                                                                                                           | Documentarlo, pull manuale                                   |
| Rename o transfer su GitHub rompe `owner/name` dell'upstream in Code.Storage            | Fase 0, GitHub 8 (rename). Transfer in pausa             | Rename: **piano B attivo e verificato**. Il pull regge, il push fallisce a intermittenza con 403 `GitHub App not installed or repo not found`. `upstream.delete` più `repos.create` col nome nuovo sullo stesso store lo ripara. Transfer: non verificato | Ricollegare l'upstream dal webhook `repository` (verificato) |
| Una regola di protezione del provider respinge il push inoltrato senza un errore chiaro | Fase 0, GitHub 7                                         | GitHub: verificato. Errore chiaro, righe `remote:` di GitHub (`GH006 ... Changes must be made through a pull request`)                                                                                                                                    | Tradurre l'errore, mostrare la regola violata                |
| Il token OAuth non funziona come password git su Forgejo e Codeberg                     | Fase 0, Forgejo 4. Codeberg reale in pausa               | Verificato su Forgejo: il token OAuth funziona come password git, con qualunque username. Codeberg reale non verificato                                                                                                                                   | Token incollato dall'utente solo per quel provider           |
| Un hook utente o org di Forgejo non scatta per tutte le repo                            | Fase 0, Forgejo 5                                        | Verificato: scatta per tutte le repo, anche quelle create dopo. Firma HMAC-SHA256 in `x-forgejo-signature`, UUID in `x-forgejo-delivery`                                                                                                                  | Hook per repo come su GitLab                                 |
| La creazione di webhook su GitLab richiede un ruolo che l'utente non ha                 | In pausa                                                 | Non verificato                                                                                                                                                                                                                                            | Pull pigro e cron                                            |
| Il refresh token scade o viene rifiutato                                                | Fase 0, Forgejo 4 (scadenza accorciata). GitLab in pausa | Verificato su Forgejo: con credenziale scaduta il pull dice ok ma non sincronizza (fallimento silenzioso); il refresh token è monouso; `gitCredentials.update` ripara. GitLab non verificato                                                              | `needs_reconnect` e riconnessione                            |
| Rate limit dei provider durante un import grande                                        | In pausa (Fasi 2 e 4 lo incontrano)                      | Non verificato                                                                                                                                                                                                                                            | Concorrenza bassa, ETag, coda                                |
| Le PR da fork non hanno commit né patch recuperabili                                    | In pausa (serve un secondo account)                      | Parziale: PR chiusa con branch cancellato e mai sincronizzato verificata (testa assente, `.diff` di GitHub disponibile, `createFromDiff` la ricrea). Fork vere: non verificate                                                                            | Link al provider                                             |
| (nuovo) `repos.create` senza `default_branch`                                           | Fase 0, GitHub 1                                         | Verificato: risponde `412 github_repository_inaccessible` pur avendo l'App accesso                                                                                                                                                                        | Mandare sempre `default_branch` letto dal provider           |

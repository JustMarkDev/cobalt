# Code Storage probe: results

Written by `packages/git/probe/run.ts`. Each section below is the last run of
one scenario: outcome, timings, the exact answers, and what it means for the
risk table in `docs/plans/provider-sync.md`. Re-run a scenario with
`railway run -- bun packages/git/probe/run.ts --scenario <id>`, or all GitHub
scenarios with `--only github`. This summary is written by hand and kept by the
runner; the sections are rewritten by each run.

## Summary (GitHub, App mode, 2026-11-24)

| Risk                                                            | Scenario | Status                  | What we saw                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A push after the provider moved is refused unclearly            | 04       | verified                | Refused, nothing overwritten. Git says `! [rejected] HEAD -> main (fetch first)`. The store's own ref was still the old tip, so GitHub refused it during the forward: the forward is synchronous.                                                                                                                                           |
| Force push and branch deletion do not propagate                 | 05, 06   | verified                | Force pushes and branch/tag deletions propagate both ways: to GitHub inside the push, to the store after `upstream.pull`.                                                                                                                                                                                                                   |
| Rename or transfer breaks `owner/name`                          | 08       | plan B active, verified | After a rename, `upstream.pull` still works (redirect), but pushes fail intermittently with `remote: GitHub App not installed or repo not found: <old owner/name>` and HTTP 403. `upstream.delete` then `repos.create` with the new name on the same store relinks it, history kept; push and pull then work. Transfer not tested (paused). |
| A provider protection rule refuses the forwarded push unclearly | 07       | verified                | Refused with GitHub's own lines: `remote: error: GH006: Protected branch update failed for refs/heads/main.`, `remote: - Changes must be made through a pull request.`, `! [remote rejected] HEAD -> main (protected branch hook declined)`. Neither side moved. The App does not bypass the rule.                                          |

Other answers:

- **`default_branch` is required in practice (01).** Without it, `repos.create`
  with a GitHub upstream answers `412 github_repository_inaccessible: GitHub App
  lacks required permissions for <owner>/<name>`, although the App has access.
  With it, the same call is accepted. The docs say it is optional.
- **First sync (01, 09):** a new small repository in about 2 s; git/git (full
  history, root commit of 2005 readable) in about 15 s, in App mode through a
  fork and in public mode alike. While it runs, `branches.list` and
  `commits.get` answer `409 sync_in_progress: repository sync in progress.
  please retry shortly`; `upstream.pull` answers ok. A second `repos.create`
  with the same upstream is idempotent; with another upstream it answers
  `409 upstream_already_configured`.
- **GitHub to store (02):** nothing arrives on its own within 45 s (the App
  webhook does not point at Code Storage). After `upstream.pull` a commit is
  visible in about 1.4 s.
- **Store to GitHub (03):** a push takes 1.7 to 2.2 s. The GitHub API showed
  the commit 0.4 to 1.9 s after git returned (polled every second). The forward
  itself happens inside the push: GitHub's refusals (04, 07) come back as the
  push's own answer.
- **Closed PR with a deleted branch (10):** a head that was synced before the
  branch was deleted stays readable by sha; one that was never synced is
  `404 not_found`. GitHub still serves the PR's `.diff`, and
  `commits.createFromDiff` rebuilds it on an ephemeral branch with the same
  content.
- **LFS (11):** an object uploaded through the store's LFS batch API, with its
  pointer pushed, is on GitHub's LFS right after the push.

## Summary (Forgejo 17.0.2, generic mode, 2026-11-24)

A local Forgejo reached by Code Storage through a Cloudflare quick tunnel
(`packages/git/probe/forgejo/env.ts`). Forgejo is what Codeberg runs; Codeberg
itself was not tested.

| Risk                                                    | Scenario | Status             | What we saw                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | -------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A push after the provider moved is refused unclearly    | F3       | verified           | Same as GitHub: `! [rejected] HEAD -> main (fetch first)`, nothing overwritten. Force push and deletions propagate both ways.                                                                                                                                                                                                                                                                                                                                                                                              |
| The OAuth token does not work as a git password         | F4       | verified (Forgejo) | An OAuth access token works as the git password, with the login or any username (`oauth2`).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The refresh token expires or is refused                 | F4       | verified (Forgejo) | An expired credential fails **silently** on pull: `upstream.pull` answers `Repository sync initiated successfully` and nothing arrives. A push fails with `remote: Error when communicating with GitHub (<forgejo url>): GitHub rejected write: authentication required or access denied` (Code Storage says "GitHub" for every host). Forgejo refresh tokens are single-use: reusing one answers `HTTP 400 unauthorized_client token was already used`. `gitCredentials.update` during a pull works; the next pull syncs. |
| A Forgejo user or org hook does not fire for every repo | F5       | verified           | A user hook fires for repos made before and after it; an org hook for every org repo. Signature: HMAC-SHA256 hex of the raw body in `x-forgejo-signature` (also `x-gitea-signature`, `x-hub-signature-256`). Delivery id: a UUID in `x-forgejo-delivery`.                                                                                                                                                                                                                                                                  |

Other answers:

- **F1:** generic `repos.create` plus `gitCredentials.create`: first sync in
  about 2.5 s. A second create answers `409 credential_exists: a credential
  already exists for this customer and repository`. With no credential, a
  private upstream stays in `409 sync_in_progress` (10 s later) while
  `upstream.pull` answers ok; adding the credential and pulling syncs it in
  about 2 s.
- **F2:** without a pull nothing arrives in 60 s; after `upstream.pull`,
  1.4 to 1.6 s.

Consequences: refresh on the stored expiry before every pull and forwarded
push (never wait for an error, since a pull with a dead credential says ok);
serialize refreshes and store the new refresh token in the same transaction,
because the old one is spent; translate Code Storage's "Error when
communicating with GitHub" for non-GitHub hosts.

Not run: everything the plan pauses (GitLab, Codeberg itself, fork PRs, real
rate limits, transfer).

<!-- probe:github-01-create:begin -->

## github-01-create: Create with an upstream: first sync and sync_in_progress

- Run: 2026-11-24T20:28:26.397Z (9.2 s)
- Outcome: **finding**
- Found: Without default_branch, repos.create answers: 412 github_repository_inaccessible 412 github_repository_inaccessible: GitHub App lacks required permissions for JustMarkDev/cobalt-probe-mwv56rs6-create. With it: repos.create took 186 ms; main arrived 1769 ms later. No call answered sync_in_progress during the sync.
- Consequence: GitStores.provision must always send default_branch with an upstream (Phase 1 makes it required in the type), read from the provider first; a 412 github_repository_inaccessible is not proof the App lacks access. The import job waits for the first sync by polling the default branch, and retries any call that answers 409 sync_in_progress.

```text
[   5.1s] GitHub main 043cfbd9ac672bc9a660bf014a1a4c6951bfcc0a
[   5.9s] repos.create without default_branch: 412 github_repository_inaccessible 412 github_repository_inaccessible: GitHub App lacks required permissions for JustMarkDev/cobalt-probe-mwv56rs6-create body={"type":"about:blank","title":"Precondition Failed","status":412,"detail":"GitHub App lacks required permissions for JustMarkDev/cobalt-probe-mwv56rs6-create","code":"github_repository_inaccessible","error":"GitHub App lacks required permissions for JustMarkDev/cobalt-probe-mwv56rs6-create"}
[   6.1s] repos.create accepted in 186 ms
[   7.8s] branches.list: branches main (first seen)
[   8.0s] repos.create again, same upstream: accepted (idempotent)
[   8.1s] repos.create again, other upstream: 409 upstream_already_configured 409 upstream_already_configured: repository already has an upstream configured body={"type":"about:blank","title":"Conflict","status":409,"detail":"repository already has an upstream configured","code":"upstream_already_configured","error":"repository already has an upstream configured"} (code upstream_already_configured)
[   8.2s] cleanup: Code Storage cobalt-probe-mwv56rs6-create: done
[   9.2s] cleanup: GitHub cobalt-probe-mwv56rs6-create: done
```

<!-- probe:github-01-create:end -->

<!-- probe:github-02-pull:begin -->

## github-02-pull: GitHub to Code Storage with upstream.pull

- Run: 2026-11-24T20:28:26.398Z (62.4 s)
- Outcome: **pass**
- Found: A GitHub commit did not arrive within 45 s without a pull. After upstream.pull: 1486, 1751, 1491 ms (median 1491 ms).
- Consequence: Code Storage does not notice GitHub changes by itself while the App webhook points at Cobalt: the /hooks/github receiver must call upstream.pull on every push (Phase 2), with the lazy pull and cron as fallback.

```text
[   6.5s] pair cobalt-probe-mwv56yuz-pull: first sync after 852 ms
[   7.9s] GitHub commit d6854c1e9cf8ba6a5f8844ba126dde2f90ff76d9; waiting 45 s without a pull
[  53.7s] did not arrive without a pull
[  53.9s] upstream.pull answered in 225 ms (0 busy retries): "Repository sync initiated successfully"
[  55.2s] sample 1: commit visible 1486 ms after the pull call
[  57.0s] upstream.pull answered in 184 ms (0 busy retries): "Repository sync initiated successfully"
[  58.6s] sample 2: commit visible 1751 ms after the pull call
[  60.1s] upstream.pull answered in 172 ms (0 busy retries): "Repository sync initiated successfully"
[  61.4s] sample 3: commit visible 1491 ms after the pull call
[  61.5s] cleanup: Code Storage cobalt-probe-mwv56yuz-pull: done
[  62.4s] cleanup: GitHub cobalt-probe-mwv56yuz-pull: done
```

<!-- probe:github-02-pull:end -->

<!-- probe:github-03-push:begin -->

## github-03-push: Code Storage to GitHub with a push

- Run: 2026-11-24T20:28:26.398Z (17.8 s)
- Outcome: **pass**
- Found: Pushes took 2084, 2160, 1829 ms and were on GitHub 405, 1931, 402 ms after the push returned.
- Consequence: The forward to GitHub lags the push; a reader of GitHub can briefly see the old state.

```text
[   7.3s] pair cobalt-probe-mwv58az8-push: first sync after 1829 ms
[  10.2s] push 1 (2084 ms) exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv58az8-push.git
   f45c897..d407344  HEAD -> main
[  10.6s] on GitHub 405 ms after the push returned
[  12.8s] push 2 (2160 ms) exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv58az8-push.git
   d407344..91849b7  HEAD -> main
[  14.7s] on GitHub 1931 ms after the push returned
[  16.6s] push 3 (1829 ms) exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv58az8-push.git
   91849b7..421c9f7  HEAD -> main
[  17.0s] on GitHub 402 ms after the push returned
[  17.1s] cleanup: Code Storage cobalt-probe-mwv58az8-push: done
[  17.8s] cleanup: GitHub cobalt-probe-mwv58az8-push: done
```

<!-- probe:github-03-push:end -->

<!-- probe:github-04-divergence:begin -->

## github-04-divergence: Divergence: GitHub moved, push to Code Storage without a pull

- Run: 2026-11-24T20:28:26.398Z (28.0 s)
- Outcome: **pass**
- Found: The push was refused (exit 1). Git said: ! [rejected] HEAD -> main (fetch first) | error: failed to push some refs to 'https://cobaltforge.code.storage/cobalt-probe-mwv58oq2-diverge.git'. GitHub kept its commit; store main stayed 4e29d30, so the refusal came from GitHub during the forward, not from the store's own ref.
- Consequence: Nothing is overwritten. The git proxy should translate this answer into "the provider has newer commits: pull first", and can pull before forwarding to make it rarer.

```text
[   7.3s] pair cobalt-probe-mwv58oq2-diverge: first sync after 1889 ms
[   9.3s] GitHub moved: main 4e29d30 -> 00d465d; no pull
[   9.4s] store main before the push: 4e29d30
[  10.2s] push of 59fd333 (777 ms) exit 1:
To https://cobaltforge.code.storage/cobalt-probe-mwv58oq2-diverge.git
 ! [rejected]        HEAD -> main (fetch first)
error: failed to push some refs to 'https://cobaltforge.code.storage/cobalt-probe-mwv58oq2-diverge.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
[  21.2s] 10 s later: GitHub main 00d465d (GitHub commit kept: true, pushed commit there: false); store main 4e29d30
[  21.4s] upstream.pull: "Repository sync initiated successfully"
[  26.6s] store main after the pull: 00d465d
[  27.2s] same push after the pull, exit 1:
To https://cobaltforge.code.storage/cobalt-probe-mwv58oq2-diverge.git
 ! [rejected]        HEAD -> main (fetch first)
error: failed to push some refs to 'https://cobaltforge.code.storage/cobalt-probe-mwv58oq2-diverge.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
[  27.3s] cleanup: Code Storage cobalt-probe-mwv58oq2-diverge: done
[  28.0s] cleanup: GitHub cobalt-probe-mwv58oq2-diverge: done
```

<!-- probe:github-04-divergence:end -->

<!-- probe:github-05-force:begin -->

## github-05-force: Force push on GitHub and on Code Storage

- Run: 2026-11-24T20:28:26.398Z (18.2 s)
- Outcome: **pass**
- Found: GitHub force push followed by the store (1332 ms after the pull). Code Storage force push forwarded to GitHub.
- Consequence: Force pushes propagate both ways. Cobalt branch protection (the no-force-push ref policy in remote.ts) is what stops them, not the provider.

```text
[   6.5s] pair cobalt-probe-mwv59acb-force: first sync after 864 ms
[   9.4s] setup: store has 86c56c3: true
[  12.4s] force push to GitHub 41750c4 exit 0: To https://github.com/JustMarkDev/cobalt-probe-mwv59acb-force.git
 + 86c56c3...41750c4 HEAD -> main (forced update)
[  12.6s] upstream.pull: "Repository sync initiated successfully"
[  13.9s] store followed the GitHub force push after 1332 ms
[  16.9s] force push to Code Storage d9e4d10 exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv59acb-force.git
 + 41750c4...d9e4d10 HEAD -> main (forced update)
[  17.3s] GitHub followed after 433 ms
[  17.5s] cleanup: Code Storage cobalt-probe-mwv59acb-force: done
[  18.2s] cleanup: GitHub cobalt-probe-mwv59acb-force: done
```

<!-- probe:github-05-force:end -->

<!-- probe:github-06-delete:begin -->

## github-06-delete: Branch and tag deletion in both directions

- Run: 2026-11-24T20:28:26.398Z (22.2 s)
- Outcome: **pass**
- Found: Branch and tag deletions propagate both ways (GitHub to store after a pull, store to GitHub with the push).
- Consequence: Nothing to build for deletions; the webhook-driven pull carries them.

```text
[   7.4s] pair cobalt-probe-mwv59odz-delete: first sync after 1752 ms
[  11.1s] GitHub branch and tag in the store: true (1376 ms)
[  14.9s] after deleting on GitHub and a pull: branch gone true, tag gone true (1703 ms)
[  17.6s] push branch and tag to the store exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv59odz-delete.git
 * [new branch]      HEAD -> cs-branch
 * [new tag]         HEAD -> cs-tag
[  18.5s] branch and tag on GitHub: true (927 ms)
[  20.4s] push --delete to the store exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv59odz-delete.git
 - [deleted]         cs-branch
 - [deleted]         cs-tag
[  21.2s] on GitHub after the delete: branch gone true, tag gone true (843 ms)
[  21.4s] cleanup: Code Storage cobalt-probe-mwv59odz-delete: done
[  22.2s] cleanup: GitHub cobalt-probe-mwv59odz-delete: done
```

<!-- probe:github-06-delete:end -->

<!-- probe:github-07-protection:begin -->

## github-07-protection: GitHub branch protection against a forwarded push

- Run: 2026-11-24T20:28:26.398Z (22.6 s)
- Outcome: **pass**
- Found: The push was refused (exit 1) and neither side moved. Git said: remote: error: GH006: Protected branch update failed for refs/heads/main. | remote: - Changes must be made through a pull request. | ! [remote rejected] HEAD -> main (protected branch hook declined)
- Consequence: Provider rules are enforced on forwarded pushes. The proxy should pass the remote: lines through and name the rule (main requires a pull request).

```text
[   6.8s] pair cobalt-probe-mwv5a5hq-protect: first sync after 860 ms
[   7.4s] protection on main: pull request with one approval, enforced for admins
[  10.6s] push to protected main exit 1 (2340 ms):
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
To https://cobaltforge.code.storage/cobalt-probe-mwv5a5hq-protect.git
 ! [remote rejected] HEAD -> main (protected branch hook declined)
error: failed to push some refs to 'https://cobaltforge.code.storage/cobalt-probe-mwv5a5hq-protect.git'
[  19.2s] GitHub main 3d3ca1f, store main 3d3ca1f
[  21.7s] push to an unprotected branch exit 0, on GitHub: true
[  21.9s] cleanup: Code Storage cobalt-probe-mwv5a5hq-protect: done
[  22.6s] cleanup: GitHub cobalt-probe-mwv5a5hq-protect: done
```

<!-- probe:github-07-protection:end -->

<!-- probe:github-08-rename:begin -->

## github-08-rename: GitHub repository rename

- Run: 2026-11-24T20:28:26.398Z (52.8 s)
- Outcome: **finding**
- Found: Through the old name after a rename: pull works; push right after fails (remote: GitHub App not installed or repo not found: JustMarkDev/cobalt-probe-mwv5amxf-rename | fatal: unable to access 'https://cobaltforge.code.storage/cobalt-probe-mwv5amxf-rename.git/': The requested URL returned error: 403); push 30 s later fails (remote: GitHub App not installed or repo not found: JustMarkDev/cobalt-probe-mwv5amxf-rename | fatal: unable to access 'https://cobaltforge.code.storage/cobalt-probe-mwv5amxf-rename.git/': The requested URL returned error: 403). Relinking the same store to the new name: ok, upstream now {"provider":"github","owner":"JustMarkDev","name":"cobalt-probe-mwv5amxf-rename-renamed"}, then push works and pull works.
- Consequence: The old name is not reliable after a rename. Plan B verified: on the repository renamed/transferred webhook, call upstream.delete and repos.create with the new owner/name on the same store (history kept). The proxy translates 403 "GitHub App not installed or repo not found" into "the provider repository moved; reconnecting".

```text
[   7.3s] pair cobalt-probe-mwv5amxf-rename: first sync after 1969 ms
[   9.2s] renamed on GitHub to cobalt-probe-mwv5amxf-rename-renamed
[   9.7s] push right-after-rename: exit 128, on GitHub false: remote: GitHub App not installed or repo not found: JustMarkDev/cobalt-probe-mwv5amxf-rename | fatal: unable to access 'https://cobaltforge.code.storage/cobalt-probe-mwv5amxf-rename.git/': The requested URL returned error: 403
[  12.8s] upstream.pull after the rename: ok: Repository sync initiated successfully; GitHub commit in the store: true
[  45.0s] push thirty-seconds-later: exit 128, on GitHub false: remote: GitHub App not installed or repo not found: JustMarkDev/cobalt-probe-mwv5amxf-rename | fatal: unable to access 'https://cobaltforge.code.storage/cobalt-probe-mwv5amxf-rename.git/': The requested URL returned error: 403
[  45.9s] relink (upstream.delete, then repos.create with the new name): ok, upstream now {"provider":"github","owner":"JustMarkDev","name":"cobalt-probe-mwv5amxf-rename-renamed"}
[  48.9s] push after-relink: exit 0, on GitHub true: (no remote lines)
[  51.9s] pull after relink: true
[  52.1s] cleanup: Code Storage cobalt-probe-mwv5amxf-rename: done
[  52.8s] cleanup: GitHub cobalt-probe-mwv5amxf-rename-renamed: done
```

<!-- probe:github-08-rename:end -->

<!-- probe:github-09-large:begin -->

## github-09-large: Large repository: first sync time

- Run: 2026-11-24T20:28:26.398Z (19.9 s)
- Outcome: **pass**
- Found: git/git first sync: App mode 15 s, public mode 15 s. History: root commit e83c516 (2005-04-07T15:13:13-07:00) readable, README at it 8392 bytes. Answers during the first sync: branches.list: 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly; upstream.pull: ok; commits.get: 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly; commits.get: ok.
- Consequence: The import job must not wait inline for a large first sync: it records the job item as syncing and completes it when the default branch appears (polled by the workflow), with a timeout well above this time.

```text
[   0.3s] public mode git/git: accepted in 288 ms
[   3.0s] fork JustMarkDev/cobalt-probe-mwv5bro5-large-app ready: true (481 ms)
[   3.4s] App mode fork: accepted in 415 ms
[   5.4s] public mode during sync, branches.list: 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly
[   5.4s] App mode during sync, branches.list: 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly
[   5.6s] App mode during sync, upstream.pull: ok
[   5.6s] public mode during sync, upstream.pull: ok
[   7.4s] public mode during sync, commits.get: 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly
[   7.5s] App mode during sync, commits.get: 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly
[  16.9s] public mode during sync, commits.get: ok
[  18.1s] public mode: master present after 14.7 s
[  18.2s] App mode: master present after 14.8 s
[  18.4s] App mode head commit 77904e5
[  18.7s] history: root commit e83c516 (2005-04-07T15:13:13-07:00) readable, README at it 8392 bytes
[  18.8s] cleanup: Code Storage cobalt-probe-mwv5bro5-large-app: done
[  19.7s] cleanup: GitHub cobalt-probe-mwv5bro5-large-app: done
[  19.9s] cleanup: Code Storage cobalt-probe-mwv5bro5-large-public: done
```

<!-- probe:github-09-large:end -->

<!-- probe:github-10-closed-pr:begin -->

## github-10-closed-pr: Closed pull request with a deleted branch: head and patch

- Run: 2026-11-24T20:28:26.398Z (29.8 s)
- Outcome: **pass**
- Found: Synced then deleted: head present in the store. Never synced: head absent. GitHub still serves the .diff (yes); createFromDiff on an ephemeral branch: commit ef5d087 on ephemeral pr/2; file content matches.
- Consequence: Commits of a deleted branch stay readable by sha for now (no promise they survive gc). Phase 4: check the head sha with commits.get; when absent, store the provider patch as text. Rebuilding it with createFromDiff on an ephemeral branch works and can be tried after v1.

```text
[   6.8s] pair cobalt-probe-mwv5c6zr-closed-pr: first sync after 1797 ms
[  16.5s] A: PR #1 head 2918a42, synced then deleted: present
[  27.7s] B: PR #2 head b4e2766, never synced: absent (404 not_found 404 not_found: commit "b4e27665ee114b17270d04e4b7376ae406f87e25" not found)
[  28.6s] GitHub .diff of a closed PR with a deleted branch: 153 bytes
[  28.9s] createFromDiff: commit ef5d087 on ephemeral pr/2; file content matches
[  29.0s] cleanup: Code Storage cobalt-probe-mwv5c6zr-closed-pr: done
[  29.8s] cleanup: GitHub cobalt-probe-mwv5c6zr-closed-pr: done
```

<!-- probe:github-10-closed-pr:end -->

<!-- probe:github-11-lfs:begin -->

## github-11-lfs: LFS in App mode

- Run: 2026-11-24T20:28:26.398Z (13.3 s)
- Outcome: **pass**
- Found: Code Storage LFS upload: batch ok, upload HTTP 200. Pointer push ok. GitHub has the object (HTTP 200 [{"actions":["download"]}]).
- Consequence: LFS objects pushed through Code Storage reach GitHub in App mode; set the LFS flag on GitHub imports.

```text
[   6.3s] pair cobalt-probe-mwv5ctz2-lfs: first sync after 777 ms
[   7.0s] Code Storage LFS batch upload: HTTP 200 [{"actions":["upload","verify"]}]
[   7.7s] upload of the object: HTTP 200
[   8.4s] verify: HTTP 200
[  11.4s] push of the pointer exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv5ctz2-lfs.git
   74c31ee..eaa2e09  HEAD -> main
[  11.8s] pointer commit on GitHub: true
[  12.3s] GitHub LFS batch download (364 ms): HTTP 200 [{"actions":["download"]}]
[  12.5s] cleanup: Code Storage cobalt-probe-mwv5ctz2-lfs: done
[  13.3s] cleanup: GitHub cobalt-probe-mwv5ctz2-lfs: done
```

<!-- probe:github-11-lfs:end -->

<!-- probe:forgejo-01-create:begin -->

## forgejo-01-create: Generic mode: create, credential, first sync

- Run: 2026-11-24T20:44:39.053Z (102.0 s)
- Outcome: **pass**
- Found: Generic create plus credential: first sync 2527 ms after create. Second credential: 409 credential_exists 409 credential_exists: a credential already exists for this customer and repository. Without a credential on a private repo: create accepted, then 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly, pull ok: Repository sync initiated successfully; adding the credential and pulling syncs it.
- Consequence: Import for GitLab/Codeberg: repos.create with the upstream, then gitCredentials.create (update on credential_exists), then wait for the default branch, pulling if it does not come.

```text
[  86.0s] pair cobalt-probe-mwv5q1vx-fj-create: first sync 2527 ms after create
[  86.2s] a second gitCredentials.create: 409 credential_exists 409 credential_exists: a credential already exists for this customer and repository
[  99.1s] no credential: create accepted; 10 s later 409 sync_in_progress 409 sync_in_progress: repository sync in progress. please retry shortly; pull ok: Repository sync initiated successfully
[ 101.5s] credential added later, then a pull: synced true (1873 ms)
[ 101.7s] cleanup: Code Storage cobalt-probe-mwv5q1vx-fj-nocred: done
[ 101.8s] cleanup: Forgejo cobalt-probe-mwv5q1vx-fj-nocred: done
[ 101.9s] cleanup: Code Storage cobalt-probe-mwv5q1vx-fj-create: done
[ 102.0s] cleanup: Forgejo cobalt-probe-mwv5q1vx-fj-create: done
```

<!-- probe:forgejo-01-create:end -->

<!-- probe:forgejo-02-pull:begin -->

## forgejo-02-pull: Generic mode: pull after a provider push, no webhook

- Run: 2026-11-24T20:44:39.053Z (72.3 s)
- Outcome: **pass**
- Found: Without a pull nothing arrived in 60 s. After upstream.pull: 1418, 1611, 1555 ms.
- Consequence: Generic upstreams need Cobalt to call upstream.pull: per-repository webhooks, plus the lazy pull and slow cron as fallback (as planned).

```text
[   3.2s] pair cobalt-probe-mwv5s8km-fj-pull: first sync 2319 ms after create
[  65.1s] not arrived alone in 60 s
[  66.5s] sample 1: 1421 ms after the pull call
[  69.3s] sample 2: 1611 ms after the pull call
[  72.0s] sample 3: 1555 ms after the pull call
[  72.2s] cleanup: Code Storage cobalt-probe-mwv5s8km-fj-pull: done
[  72.3s] cleanup: Forgejo cobalt-probe-mwv5s8km-fj-pull: done
```

<!-- probe:forgejo-02-pull:end -->

<!-- probe:forgejo-03-push:begin -->

## forgejo-03-push: Generic mode: forwarded push, divergence, force push, deletion

- Run: 2026-11-24T20:44:39.053Z (19.8 s)
- Outcome: **pass**
- Found: push forwarded (on Forgejo 209 ms after git returned); divergent push refused: ! [rejected] HEAD -> main (fetch first); force push forwarded; deletions: store->Forgejo yes, Forgejo->store yes.
- Consequence: Generic mode behaves like App mode: refused divergence, force pushes and deletions propagate.

```text
[   3.0s] pair cobalt-probe-mwv5tscn-fj-push: first sync 2128 ms after create
[   5.5s] push exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv5tscn-fj-push.git
   8e4320b..0fd272a  HEAD -> main; on Forgejo true (209 ms after)
[  12.3s] push after divergence exit 1:
To https://cobaltforge.code.storage/cobalt-probe-mwv5tscn-fj-push.git
 ! [rejected]        HEAD -> main (fetch first)
error: failed to push some refs to 'https://cobaltforge.code.storage/cobalt-probe-mwv5tscn-fj-push.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
Forgejo main fefb988 (theirs fefb988, ours 555099b)
[  13.9s] force push exit 0: To https://cobaltforge.code.storage/cobalt-probe-mwv5tscn-fj-push.git
 + fefb988...cb138f2 HEAD -> main (forced update); Forgejo followed true
[  17.1s] branch via store: created on Forgejo true, deleted on Forgejo true
[  19.5s] branch via Forgejo: in store true, deletion reached the store true
[  19.7s] cleanup: Code Storage cobalt-probe-mwv5tscn-fj-push: done
[  19.8s] cleanup: Forgejo cobalt-probe-mwv5tscn-fj-push: done
```

<!-- probe:forgejo-03-push:end -->

<!-- probe:forgejo-04-tokens:begin -->

## forgejo-04-tokens: Generic mode: PAT and OAuth token as git password, expiry, refresh, credential update

- Run: 2026-11-24T20:44:39.053Z (164.2 s)
- Outcome: **pass**
- Found: OAuth access token as git password: works (info/refs 200; with username "oauth2" 200; PAT 200). After expiry: info/refs 401, upstream.pull answers "ok: Repository sync initiated successfully" and nothing arrives (silently), a push fails: remote: Error when communicating with GitHub (https://manual-sim-seeing-incredible.trycloudflare.com/probe/cobalt-probe-mwv5u7lf-fj-oauth.git/): GitHub rejected write: authentication required or access denied | fatal: Authentication failed for 'https://cobaltforge.code.storage/cobalt-probe-mwv5u7lf-fj-oauth.git/'. Refresh then gitCredentials.update during a pull: ok; sync resumes, push works. Reusing a spent refresh token: HTTP 400 unauthorized_client token was already used.
- Consequence: Plan holds for Forgejo/Codeberg: the OAuth token is the git password. An expired credential fails silently on pull (upstream.pull still says ok), so Cobalt must refresh before every pull and forwarded push, keyed on the stored expiry, not on errors. Refresh must be serialized and the new refresh token stored at once.

```text
[   0.2s] OAuth flow done; access token lives 120 s
[   3.3s] pair cobalt-probe-mwv5u7lf-fj-oauth: first sync 2263 ms after create
[   3.4s] git info/refs: PAT 200; OAuth token with username probe 200, with "oauth2" 200
[   3.4s] store synced with the OAuth token as password: true
[   3.4s] waiting 132 s for the access token to expire
[ 157.3s] expired: git info/refs 401; upstream.pull ok: Repository sync initiated successfully; commit arrived false; repos.get {"provider":"forgejo","owner":"probe","name":"cobalt-probe-mwv5u7lf-fj-oauth"}
[ 159.6s] push with the expired credential exit 128:
remote: Error when communicating with GitHub (https://manual-sim-seeing-incredible.trycloudflare.com/probe/cobalt-probe-mwv5u7lf-fj-oauth.git/): GitHub rejected write: authentication required or access denied
fatal: Authentication failed for 'https://cobaltforge.code.storage/cobalt-probe-mwv5u7lf-fj-oauth.git/'
[ 159.7s] refresh ok; reusing the old refresh token: HTTP 400 unauthorized_client token was already used
[ 160.1s] pull started (ok: Repository sync initiated successfully), then gitCredentials.update: ok
[ 161.5s] after the update and a pull, the Forgejo commit arrived: true (1251 ms)
[ 164.0s] push after the update exit 0, on Forgejo true
[ 164.1s] cleanup: Code Storage cobalt-probe-mwv5u7lf-fj-oauth: done
[ 164.2s] cleanup: Forgejo cobalt-probe-mwv5u7lf-fj-oauth: done
```

<!-- probe:forgejo-04-tokens:end -->

<!-- probe:forgejo-05-webhooks:begin -->

## forgejo-05-webhooks: User and organization webhooks: coverage, HMAC, delivery id

- Run: 2026-11-24T20:44:39.053Z (10.9 s)
- Outcome: **pass**
- Found: User hook (HTTP 201) fired for 2/2 user repos (one made before, one after the hook); org hook (HTTP 201) for 2/2 org repos. Signature: HMAC-SHA256 hex of the raw body in x-forgejo-signature (and x-gitea-signature), valid on every delivery: true. Delivery id x-forgejo-delivery, a distinct UUID each: true.
- Consequence: For Forgejo/Codeberg, one user-level hook (plus one per org the person administers) could replace per-repository hooks; it also fires for repos the person did not import, so the receiver must ignore unknown repos. v1 keeps per-repository hooks (one code path with GitLab, and least access); the user hook is a later optimization. Dedupe on x-forgejo-delivery, verify x-forgejo-signature.

```text
[   0.1s] org cobalt-probe-mwv5xqam-org: HTTP 201
[   0.8s] user hook: HTTP 201; org hook: HTTP 201
[  10.6s] probe/cobalt-probe-mwv5xqam-fj-hook-before: 1 deliveries
[  10.6s] probe/cobalt-probe-mwv5xqam-fj-hook-after: 1 deliveries
[  10.6s] cobalt-probe-mwv5xqam-org/cobalt-probe-mwv5xqam-fj-org-a: 1 deliveries
[  10.6s] cobalt-probe-mwv5xqam-org/cobalt-probe-mwv5xqam-fj-org-b: 1 deliveries
[  10.6s] headers: x-forgejo-delivery, x-forgejo-event, x-forgejo-event-type, x-forgejo-signature, x-gitea-delivery, x-gitea-event, x-gitea-event-type, x-gitea-signature, x-github-delivery, x-github-event, x-github-event-type, x-gogs-delivery, x-gogs-event, x-gogs-event-type, x-gogs-signature, x-hub-signature, x-hub-signature-256
[  10.6s] HMAC-SHA256 of the body matches x-forgejo-signature on all: true; delivery ids are distinct UUIDs: true
[  10.7s] cleanup: Forgejo cobalt-probe-mwv5xqam-org/cobalt-probe-mwv5xqam-fj-org-b: done
[  10.7s] cleanup: Forgejo cobalt-probe-mwv5xqam-org/cobalt-probe-mwv5xqam-fj-org-a: done
[  10.8s] cleanup: Forgejo cobalt-probe-mwv5xqam-fj-hook-after: done
[  10.9s] cleanup: Forgejo cobalt-probe-mwv5xqam-fj-hook-before: done
[  10.9s] cleanup: Forgejo org cobalt-probe-mwv5xqam-org: done
[  10.9s] cleanup: webhook receiver: done
```

<!-- probe:forgejo-05-webhooks:end -->

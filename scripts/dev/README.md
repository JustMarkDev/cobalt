# Testing against real data, locally

These scripts let an agent (or you) check the whole forge on your machine,
with real GitHub data, before anything goes to Railway. They only run against
a `dev:` Convex deployment, never production.

Use the **dev GitHub App** (Cobalt Forge Sync Dev), not production's: the two
apps have separate rate limits, so testing here never slows production's sync.
Its keys go in `apps/web/.env.local` (`GITHUB_APP_*`), and after switching app,
`bun scripts/dev/use-installation.ts <installation id>` points the links the
dev deployment already has at the dev app's installation.

Setup, once: `.env.local` and `apps/web/.env.local` as in the main README
(the dev deployment, its API key, the GitHub App and Code Storage keys; a
`CB_SECRETS_KEY` of 32 bytes, base64 or hex; `CB_TOKEN_KEYS` to keep users'
GitHub tokens). Then `bun run dev`.

| Command                                                       | What it does                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun scripts/dev/token.ts mark`                               | An API token for `mark` on the dev deployment (for curl, `cb`, MCP).                                                                                                                                                                                                 |
| `bun scripts/dev/check-import.ts mark/music-companion --sync` | Reads the repository here and on GitHub and lists every difference: about, pull requests (state, branch, head, files, landability), issues (state, comments, labels, close reason), releases, default branch head, contributors. Read only. Exits 1 on a difference. |
| `bun scripts/dev/cli-smoke.ts`                                | Runs every `cb` command against the local app: on a new scratch repository (create, push, change, issue with screenshots, env secrets, runner, MCP) and read only on `--read owner/name`.                                                                            |

Pipelines: register a runner with labels that cover the workflows' `runs-on`
(`cb runner register mac --labels ubuntu-latest,self-hosted`), then
`CB_RUNNER_TOKEN=… cb runner start`. A push through cobalt starts the
`.github/workflows` that take it.

What cannot happen locally: GitHub's and Code Storage's webhooks do not reach
localhost. Pushes through cobalt count at once anyway; changes made on GitHub
arrive with `--sync`, a `cb mirror sync`, or the scheduled pull.

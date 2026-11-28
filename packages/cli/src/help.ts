export const version = '0.2.0'

export const topHelp = `cb ${version}: the cobalt command line

It never asks a question. Anything it cannot work out, it tells you to pass.
Output is JSON when piped or with --json.

Commands
  repo      list, view, create, clone
  import    link a GitHub repository, in sync both ways
  change    list, view, create, ready, land, checkout
  issue     list, view, create, attach, close
  env       list, set, run, pull, confirmations
  policy    check, explain
  mirror    list, add, sync, remove
  pipeline  wait, resume (a step waiting on a person or an agent)
  runner    register, list, revoke, start (a machine that runs jobs)
  handoff   hand an issue or change to an orchestrator (T3 Code, boat)
  context   everything an agent needs, no secret values
  config    list, get, set, path
  account   list, current, switch (one login, any account)
  commands  every command as JSON (for agents)
  skill     print or install the agent skill that teaches cb
  mcp       serve the MCP server over stdio
  auth      status, login
  upgrade   replace this cb with the latest release
  completion  bash, zsh, fish

Using an agent? Run: cb skill install   (then it knows cb), or: cb commands

Flags on every command
  -R, --repo owner/name   which repository (default: the git remote)
  -A, --account handle    act as this account (default: the repo's owner,
                          else the one you switched to, else you)
  -j, --json              JSON output (default when piped)
  -n, --dry-run           say what would happen, change nothing
      --no-color          or set NO_COLOR

Exit codes
  0 ok  1 error  2 usage  3 not found  4 not signed in  5 policy blocked  6 needs a human
`

export const groupHelp: Record<string, string> = {
  change: `cb change <command>

  list [--all]            open changes, or every change
  view [number]           one change and what blocks it (default: current branch)
  create [--draft]        make a change from the current branch
                          title = last commit, base = default branch
                          run again to add a patch set
                          --addresses cmt_1,cmt_2  threads the patch set fixes
  timeline [number]       everything that happened to it, oldest first
  presence [number]       who else is looking, and at which file
                          --here [--path f] says you are; --leave that you left
  guide [number]          what it does and the order to read its files in
                          --set '{"summary":…,"order":[{"path","why","risk"}]}'
  ready [number]          a draft is ready for review (and can land)
  land [number]           land exactly the tree it just read, if policy allows
  checkout <number>       print the git command to switch to its branch
`,
  repo: `cb repo <command>

  list [--all]            repositories of the account you act as (--all: every account)
  view                    the current repository
  create <name>           create one in the account you act as (--private, --description)
                          or name the owner: create owner/name
  clone owner/name        print the clone command
`,
  issue: `cb issue <command>

  list [--state all]      open issues by default
  view <n>
  timeline <n>            comments, reviews, linked changes, oldest first
  presence <n>            who else is looking (--here, --leave)
  create <title>          --label bug,docs --body <text> | --body-file <file|->
                          --screenshot a.png,b.webm [--caption <text>]
                          Same title twice returns the open one.
  attach <n> <file...>    add screenshots or recordings to an issue (--caption)
  close <n>
`,
  env: `cb env <command>   (--env development|preview|production)

  list                    names, kinds and whether each has a value. Never values.
  set <NAME> -            set a value from stdin; the server seals it. Team only.
  run -- <command>        run with values injected into that process only; output is scrubbed
                          with a .env.schema, Varlock checks the values first
                          (required, types) and redacts sensitive ones (--no-validate)
  pull --plaintext        write .env.local (0600). Prefer run: a file is what leaks.
  confirmations           your production confirmations, and where to confirm one
  commit [files] [--staged] .env files into cobalt, not into git: each value
                          sealed for its file's environment (.env and .env.local:
                          development, .env.preview, .env.production), names
                          added to .env.schema, the files kept out of the index
  hook install|uninstall  a pre-commit hook: git add .env && git commit runs
                          cb env commit --staged

  Values follow your login: on the repository's team, any machine you sign in
  on (cb auth login) reads them, and so does an agent you run there. Production
  waits until you confirm the login on a signed-in page.
`,
  policy: `cb policy <command>

  check <change>          exits 5 when the change is blocked
  explain <change>        the same, listing each requirement
`,
  import: `cb import <host> <owner/name>   or   cb import <url>

  Makes the repository here with its whole history and keeps it in sync with
  its host both ways: what is pushed here reaches it and the other way round,
  until you cb mirror remove it. Its pull requests, issues and releases
  follow, read-only. Anyone who can write here can push there through cobalt;
  the host's branch rules still apply.

  GitHub asks you to sign in (a code to type at github.com/login/device) to
  prove you may push to it. GitLab and Codeberg are connected once, in the
  browser, in the site's account settings.

  host                    github, gitlab or codeberg
  --github-access <proof> skip the GitHub sign-in (or set CB_GITHUB_ACCESS)
  --as name|owner/name    where it goes (default: its name, in the account you act as)
  --private               private here (default: public)
  list                    what you imported and how each mirror is doing
  connections             your GitLab, Codeberg and GitHub accounts
  batch <host> <owner/name>...   many at once, in the background (--no-wait)
  job <id>                how a batch is going
`,
  mirror: `cb mirror <command>

  list
  add github <owner/name> publish this repository to GitHub and keep the two
                          in sync both ways. The GitHub repository must be
                          empty, or not exist yet (cobalt makes it when its
                          GitHub App may). Signs in with GitHub like import.
  sync <id>               fetch from its host now
  remove <id>             unlinks it. History here is untouched.

  A repository from another host is linked when it is imported: cb import.
`,
  pipeline: `cb pipeline <command>

  wait <run> --job N --step N --reason "…" [--kind person|agent|approval]
       [--target handle] [--expires 2026-12-01T09:00:00Z]
                          pause a running step; it fails if nobody resumes it
                          by then (7 days by default, 30 at most)
  resume <run> --job N --step N --status success|failure [--note "…"]
                          end a waiting step; the runner carries on
`,
  runner: `cb runner <command>

  register <name> [--labels macos,arm64] [--repos owner/a,owner/b]
           [--concurrency N] [--provider blacksmith] [--account org]
                          prints the runner's token, once
  list [--account org]
  revoke <id>             disables it; its token stops working at once
  start [--workdir dir] [--once]
                          with CB_RUNNER_TOKEN set: heartbeat, claim jobs its
                          labels cover and run them as GitHub's runner would:
                          run: steps, JavaScript and composite actions, matrix,
                          needs, if:, outputs, GITHUB_ENV and GITHUB_PATH

  One runner serves every repository of the account. Two labels make it your
  agent too:
    t3        the Hand off button opens a T3 Code thread on this machine
    reviewer  each new change or patch set gets an AI review: opencode (or
              CB_REVIEW_COMMAND) reads the diff and posts findings
  Example: cb runner register my-mac --labels ubuntu-latest,self-hosted,t3,reviewer
`,
  handoff: `cb handoff <issue|change|run:N>   (--to t3|boat)

  Builds the prompt from the issue or change and prints the command that hands
  it to the orchestrator. cobalt runs no agent: the orchestrator starts
  one under your login, and its writes come back with a receipt.
`,
  account: `cb account <command>

  list                    every account you can act as, and your role in each
  current                 who you act as now, and why (flag, env, repo, setting, default)
  switch <handle>         act as that account from now on (saved in your settings)

  One login covers yourself and every organization you belong to, so there is
  nothing to sign in to again. Which account a command acts as, in order:
    1. -A, --account handle
    2. CB_ACCOUNT
    3. the owner of the repository you are in, when you can act as it
    4. the account saved by cb account switch
    5. you
`,
  upgrade: `cb upgrade [--to x.y.z] [--dry-run]

  Replaces this cb with the latest release (or --to), checked against
  its SHA-256. Installed with npm or run from a checkout: update it that way.
`,
  auth: `cb auth <command>

  status                  signed in? to what, as whom, with which scopes (exit 4: no)
  login [--scope "a b"]   sign in with a code you approve in a browser (saves a token that refreshes)
  logout                  revoke the saved sign-in and delete it

  CB_TOKEN in the environment always wins over a saved sign-in. CB_API (or
  \`cb config set api <url>\`) says which server; with neither, cb runs the
  preview's sample data in this process.
`,
  config: `cb config <command>

  list                    every setting, its value and where it came from
  get <key>
  set <key> <value>
  path                    where the file lives
`,
}

export const completions: Record<string, string> = {
  bash: `_cb() { COMPREPLY=($(compgen -W "repo import change issue env policy mirror pipeline runner handoff context config account auth skill mcp upgrade commands completion" -- "\${COMP_WORDS[COMP_CWORD]}")); }
complete -F _cb cb cobalt
`,
  zsh: `#compdef cb cobalt
_arguments '1: :(repo import change issue env policy mirror pipeline runner handoff context config account auth skill mcp upgrade commands completion)'
`,
  fish: `complete -c cb -f -a "repo import change issue env policy mirror pipeline runner handoff context config account auth skill mcp upgrade commands completion"
complete -c cobalt -f -a "repo import change issue env policy mirror pipeline runner handoff context config account auth skill mcp upgrade commands completion"
`,
}

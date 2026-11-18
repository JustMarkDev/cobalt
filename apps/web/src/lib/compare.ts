// How source.code compares with other hosts, as a checklist: a short title, one
// line under it, and a mark per product. A note sits only on the marks that
// need one. These are claims about other people's products, so a mark is never
// better for us than what we could confirm: what we could not confirm is
// `unclear`, not `no`. The research behind each mark, with its sources, is in
// this file's git history (November 2026).

export type Product =
  | 'us'
  | 'github'
  | 'gitlab'
  | 'forgejo'
  | 'origin'
  | 'gitcafe'
  | 'trylle'

export const products: Array<{ id: Product; name: string; note?: string }> = [
  { id: 'us', name: 'source.code' },
  { id: 'github', name: 'GitHub' },
  { id: 'gitlab', name: 'GitLab' },
  { id: 'gitcafe', name: 'GitCafe', note: 'Public beta' },
  { id: 'origin', name: 'Origin', note: 'Cursor only' },
  { id: 'trylle', name: 'Trylle' },
  { id: 'forgejo', name: 'Forgejo' },
]

/** `unclear` is for what we could not confirm from public documentation. */
export type Level = 'yes' | 'partly' | 'no' | 'unclear'

export const levelLabel: Record<Level, string> = {
  yes: 'Yes',
  partly: 'In part',
  no: 'No',
  unclear: 'Not documented',
}

export type Cell = { level: Level; note?: string }

export type Row = {
  id: string
  title: string
  /** One short line under the title, in plain words. */
  detail: string
  cells: Record<Product, Cell>
}

const yes = (note?: string): Cell => ({ level: 'yes', note })
const partly = (note: string): Cell => ({ level: 'partly', note })
const no = (note?: string): Cell => ({ level: 'no', note })
const unclear: Cell = { level: 'unclear' }

export const rows: Array<Row> = [
  {
    // Ours is the storage underneath (code.storage's SLA), not a measured
    // track record: we have none until we are hosted. GitHub's figure is The
    // Missing GitHub Status Page (mrshu.github.io/github-statuses), rebuilt
    // from its incident history, because GitHub no longer publishes one.
    id: 'uptime',
    title: 'Built to stay up',
    detail: 'Git on replicated storage with a 99.99% uptime SLA.',
    cells: {
      us: yes(
        'Repositories live on code.storage: quorum-replicated writes, failover without downtime, and a 99.99% monthly SLA.',
      ),
      github: no('93.88% uptime over the last 90 days, with 58 incidents.'),
      gitlab: partly('A 99.9% SLA, with service credits only on Ultimate.'),
      gitcafe: no('In beta, with no service-level commitment.'),
      trylle: partly(
        'No published SLA. Its status page shows 99.89% to 100% over 60 days.',
      ),
      origin: no('Early beta, with no published SLA.'),
      forgejo: partly(
        'Up to whoever runs it. Codeberg shows about 99.7%, with weekly maintenance of up to 8 hours.',
      ),
    },
  },
  {
    id: 'mcp',
    title: 'Built-in MCP server',
    detail: 'Connect any agent in one command.',
    cells: {
      us: yes(),
      github: yes(),
      gitlab: yes(),
      forgejo: no('Community servers only.'),
      origin: yes('In early beta.'),
      gitcafe: yes(),
      trylle: no('Agents use its CLI skill instead.'),
    },
  },
  {
    id: 'anyagent',
    title: 'Any agent, any model',
    detail: 'Claude Code, Codex or yours, on your own bill.',
    cells: {
      us: yes(),
      github: partly('Copilot, Claude and Codex, paid in premium requests.'),
      gitlab: partly(
        'Its own agents plus a few others, paid in GitLab Credits.',
      ),
      forgejo: no('No agent features.'),
      origin: partly('Cursor’s own agents.'),
      gitcafe: yes(),
      trylle: partly('Codex, Claude or OpenCode, paid from its AI credit.'),
    },
  },
  {
    // No hosted CI is a choice: the runner, its hardware and its bill are
    // yours, and we never sell compute.
    id: 'runners',
    title: 'Your runners, no minutes to buy',
    detail: 'Run CI on Blacksmith or your own machines.',
    cells: {
      us: yes(),
      github: no('Sells Actions minutes.'),
      gitlab: no('Sells compute minutes.'),
      forgejo: yes(),
      origin: yes('Depot or Buildkite, connected as apps.'),
      gitcafe: partly('Its own hosted runners, in beta, or yours.'),
      trylle: no('Sells CI minutes.'),
    },
  },
  {
    // An estimate, not a measurement: we are not hosted yet. It assumes a
    // network like GitCafe's and a server that adds little on top.
    id: 'speed',
    title: 'Fast API',
    detail: 'About 100 to 150 ms for a single issue, most of it the network.',
    cells: {
      us: yes(),
      github: no('About 300 ms for a single issue.'),
      gitlab: no('About 300 ms for a single issue.'),
      forgejo: partly('160 to 360 ms for a single issue on Codeberg.'),
      origin: unclear,
      gitcafe: yes('About 125 ms, almost all of it the network.'),
      trylle: unclear,
    },
  },
  {
    id: 'secrets',
    title: 'Production secrets wait for a person',
    detail: 'Agents read them only after someone confirms in the browser.',
    cells: {
      us: yes(),
      github: no('Secrets in the agent’s environment are passed to the agent.'),
      gitlab: yes('Its agent flows get no custom CI/CD variables at all.'),
      forgejo: unclear,
      origin: unclear,
      gitcafe: no(
        'Every CI job gets every repository secret, with no approval step.',
      ),
      trylle: unclear,
    },
  },
  {
    id: 'agentrules',
    title: 'Turn away weak models',
    detail: 'Decline changes written with models you do not trust.',
    cells: {
      us: yes(),
      github: no(),
      gitlab: no(),
      forgejo: no(),
      origin: unclear,
      gitcafe: no('Rulesets have no rule about models.'),
      trylle: unclear,
    },
  },
  {
    id: 'provenance',
    title: 'Every line traces to its model',
    detail: 'The machine, tool and model behind any change.',
    cells: {
      us: yes(),
      github: partly('Only for commits by Copilot’s own agent.'),
      gitlab: partly('An audit report of agent sessions, in beta.'),
      forgejo: no(),
      origin: partly('Marks commits a Cursor agent made, not the model.'),
      gitcafe: unclear,
      trylle: partly('Only its own automation runs record the model.'),
    },
  },
  {
    id: 'rewrites',
    title: 'Review only what’s new',
    detail: 'Even after a rebase or a force-push.',
    cells: {
      us: yes(),
      github: partly('Can lose its place after a rewrite.'),
      gitlab: yes(),
      forgejo: partly('Can compare the commits before and after a force-push.'),
      origin: partly('Shows the commits before and after a force-push.'),
      gitcafe: partly(
        'Old reviews stay on their commits. No view of what changed since.',
      ),
      trylle: unclear,
    },
  },
  {
    id: 'stacks',
    title: 'Stacked changes',
    detail: 'Small changes that land in order.',
    cells: {
      us: yes(),
      github: yes(),
      gitlab: partly('Still an experiment in the CLI.'),
      forgejo: no(),
      origin: yes(),
      gitcafe: yes(),
      trylle: yes(),
    },
  },
  {
    id: 'policy',
    title: 'Merge rules as code',
    detail: 'Reviewed and versioned like any change.',
    cells: {
      us: yes(),
      github: partly('Rulesets live in settings. CODEOWNERS is a file.'),
      gitlab: partly('Kept in a separate policy project.'),
      forgejo: partly(
        'Branch protection lives in settings. CODEOWNERS is a file.',
      ),
      origin: partly(
        'Rulesets live in settings or Terraform. Code owners are a file.',
      ),
      gitcafe: no(),
      trylle: no('Branch protection lives in settings.'),
    },
  },
  {
    id: 'leave',
    title: 'Leave with everything',
    detail: 'Mirror out with issues and reviews included.',
    cells: {
      us: yes(),
      github: partly('Code and history only.'),
      gitlab: partly('Mirrors carry code only.'),
      forgejo: partly('Mirrors carry code only.'),
      origin: partly('Syncs with GitHub only.'),
      gitcafe: yes(),
      trylle: partly('Two-way GitHub sync of code and history.'),
    },
  },
]

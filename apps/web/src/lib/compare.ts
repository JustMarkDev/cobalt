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
      gitlab: unclear,
      gitcafe: unclear,
      trylle: partly(
        'No published SLA. Its status page shows 99.89% to 100% over 60 days.',
      ),
      origin: unclear,
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
      origin: unclear,
      gitcafe: yes(),
      trylle: unclear,
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
    id: 'speed',
    title: 'Fast API',
    detail: 'About 1 ms past the network for a cached read.',
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
    title: 'Secrets agents never see',
    detail: 'Commands get the value. The agent never does.',
    cells: {
      us: yes(),
      github: no('Secrets in the agent’s environment are passed to the agent.'),
      gitlab: unclear,
      forgejo: no(),
      origin: unclear,
      gitcafe: unclear,
      trylle: unclear,
    },
  },
  {
    id: 'agentrules',
    title: 'Agents can’t approve their own work',
    detail: 'Each agent gets its own scoped, expiring token.',
    cells: {
      us: yes(),
      github: partly('Copilot code review can approve, if you turn that on.'),
      gitlab: partly(
        'Agents run as service accounts, with no rules of their own.',
      ),
      forgejo: partly('Bot accounts, with nothing specific to agents.'),
      origin: unclear,
      gitcafe: partly('Scoped tokens. Self-approval is not addressed.'),
      trylle: partly(
        'Bot identities with scoped permissions. Self-approval is not addressed.',
      ),
    },
  },
  {
    id: 'provenance',
    title: 'Every line traces to its agent',
    detail: 'Find the session and prompt behind any change.',
    cells: {
      us: yes(),
      github: partly('Only for commits by Copilot’s own agent.'),
      gitlab: partly('An audit report of agent sessions, in beta.'),
      forgejo: no(),
      origin: unclear,
      gitcafe: unclear,
      trylle: unclear,
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
      forgejo: unclear,
      origin: unclear,
      gitcafe: unclear,
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
      origin: unclear,
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
      origin: unclear,
      gitcafe: no(),
      trylle: unclear,
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

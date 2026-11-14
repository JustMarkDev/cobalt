// How source.code compares with other hosts. This is a claim about other
// people's products, so every cell is kept short, says what we could confirm,
// and links the page it came from where we read one. Rows where we are behind
// stay in: a comparison that only lists wins is not one.
//
// The rows are the questions a team picking a home for agent-written code
// asks: can a reviewer keep up, can agents be trusted with the keys, can the
// rules be audited, and can we leave. Review the date and the sources whenever
// a product ships something; the new hosts here ship every week.

import { trial } from './pricing'

export const checkedOn = 'November 14, 2026'

export type Product =
  | 'us'
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'forgejo'
  | 'entire'
  | 'origin'
  | 'delta'
  | 'tangled'
  | 'gitcafe'

export type Group = 'us' | 'established' | 'new'

export const groupLabel: Record<Group, string> = {
  us: '',
  established: 'Established hosts',
  new: 'New, built around agents',
}

export const products: Array<{
  id: Product
  name: string
  group: Group
  note?: string
}> = [
  { id: 'us', name: 'source.code', group: 'us' },
  { id: 'github', name: 'GitHub', group: 'established' },
  { id: 'gitlab', name: 'GitLab', group: 'established' },
  { id: 'bitbucket', name: 'Bitbucket', group: 'established' },
  {
    id: 'forgejo',
    name: 'Forgejo',
    group: 'established',
    note: 'With Gitea and Codeberg',
  },
  { id: 'entire', name: 'Entire', group: 'new', note: 'Early access' },
  { id: 'origin', name: 'Cursor Origin', group: 'new', note: 'Early beta' },
  { id: 'delta', name: 'Zed Delta', group: 'new', note: 'Public beta' },
  { id: 'tangled', name: 'Tangled', group: 'new', note: 'Federated' },
  { id: 'gitcafe', name: 'GitCafe', group: 'new', note: 'Public beta' },
]

/** `unclear` is for what we could not confirm from public documentation. */
export type Level = 'yes' | 'partly' | 'no' | 'unclear'

export const levelLabel: Record<Level, string> = {
  yes: 'Yes',
  partly: 'In part',
  no: 'No',
  unclear: 'Not confirmed',
}

export type Source = { label: string; href: string }

export type Cell = {
  level: Level
  text: string
  /** Pages we read. Community and third-party reports are named as such. */
  sources?: Array<Source>
}

export type Row = {
  id: string
  topic: string
  question: string
  /** Why the row matters, in one sentence. */
  why: string
  cells: Record<Product, Cell>
}

const src = {
  githubStacks: {
    label: 'GitHub changelog, October 2026',
    href: 'https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available',
  },
  githubAgentHq: {
    label: 'GitHub changelog, February 2026',
    href: 'https://github.blog/changelog/2026-02-26-claude-and-codex-now-available-for-copilot-business-pro-users/',
  },
  githubReviewCopilot: {
    label: 'GitHub docs: reviewing Copilot’s pull requests',
    href: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/review-copilot-prs',
  },
  githubCopilotApproves: {
    label: 'GitHub changelog, September 2026',
    href: 'https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests',
  },
  githubTrace: {
    label: 'GitHub changelog, March 2026',
    href: 'https://github.blog/changelog/2026-03-20-trace-any-copilot-coding-agent-commit-to-its-session-logs',
  },
  githubAgentEnv: {
    label: 'GitHub docs: the agent’s environment',
    href: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment',
  },
  githubRulesets: {
    label: 'GitHub docs: rulesets',
    href: 'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository',
  },
  gitlabVersions: {
    label: 'GitLab docs: diff versions',
    href: 'https://docs.gitlab.com/user/project/merge_requests/versions',
  },
  gitlabStacks: {
    label: 'GitLab docs: stacked diffs',
    href: 'https://docs.gitlab.com/user/project/merge_requests/stacked_diffs/',
  },
  gitlabDap: {
    label: 'GitLab, January 2026',
    href: 'https://about.gitlab.com/press/releases/2026-01-15-gitlab-announces-duo-agent-platform-general-availability/',
  },
  gitlabAudit: {
    label: 'GitLab docs: AI audit events',
    href: 'https://docs.gitlab.com/user/duo_agent_platform/ai-audit-events/',
  },
  gitlabTraceIssue: {
    label: 'GitLab issue 584692',
    href: 'https://gitlab.com/gitlab-org/gitlab/-/issues/584692',
  },
  gitlabPolicies: {
    label: 'GitLab docs: approval policies',
    href: 'https://docs.gitlab.com/user/application_security/policies/merge_request_approval_policies/',
  },
  bitbucketRewrite: {
    label: 'Atlassian issue BCLOUD-13397',
    href: 'https://jira.atlassian.com/browse/BCLOUD-13397',
  },
  bitbucketRovo: {
    label: 'Atlassian: Rovo Dev code review',
    href: 'https://www.atlassian.com/software/rovo-dev/code-review',
  },
  bitbucketPipelines: {
    label: 'Atlassian: agentic Pipelines',
    href: 'https://www.atlassian.com/blog/bitbucket/introducing-agentic-pipelines-ai-automation',
  },
  bitbucketMcp: {
    label: 'Atlassian community: Rovo MCP',
    href: 'https://community.atlassian.com/forums/Bitbucket-articles/Bitbucket-Cloud-is-now-available-on-the-Atlassian-Rovo-MCP/ba-p/3218447',
  },
  bitbucketImport: {
    label: 'Atlassian community thread',
    href: 'https://community.atlassian.com/forums/Bitbucket-questions/Import-repository-with-pull-requests/qaq-p/794373',
  },
  bitbucketPricing: {
    label: 'Atlassian pricing',
    href: 'https://www.atlassian.com/software/bitbucket/pricing?tab=cloud',
  },
  codebergAi: {
    label: 'It’s FOSS, July 2026',
    href: 'https://itsfoss.com/news/codeberg-bans-ai-contributions/',
  },
  entireLaunch: {
    label: 'Entire blog, October 2026',
    href: 'https://entire.com/blog/the-git-forge-for-agent-human-collaboration',
  },
  entireTrails: {
    label: 'Entire docs: Trails',
    href: 'https://docs.entire.com/guides/trails/overview',
  },
  entirePricing: {
    label: 'Entire pricing',
    href: 'https://entire.com/pricing',
  },
  entireAccounts: {
    label: 'Entire blog, November 2026',
    href: 'https://entire.com/blog/your-agents-can-now-sign-in-as-themselves',
  },
  entireGatesIssue: {
    label: 'Entire CLI issue 2932',
    href: 'https://github.com/entireio/cli/issues/2932',
  },
  entireCli: {
    label: 'Entire CLI',
    href: 'https://github.com/entireio/cli',
  },
  originChangelog: {
    label: 'Cursor changelog, August 2026',
    href: 'https://cursor.com/changelog/origin-code-hosting',
  },
  originDocs: {
    label: 'Cursor docs: Origin',
    href: 'https://cursor.com/docs/origin',
  },
  originGuide: {
    label: 'Third-party guide',
    href: 'https://www.learncursor.dev/learn/cursor-origin',
  },
  deltaBeta: {
    label: 'Zed blog, September 2026',
    href: 'https://zed.dev/blog/delta-public-beta',
  },
  deltaDb: {
    label: 'Zed blog: DeltaDB',
    href: 'https://zed.dev/blog/introducing-deltadb',
  },
  deltaReview: {
    label: 'Delta docs: review and sync',
    href: 'https://delta.dev/docs/agents/review-and-sync',
  },
  deltaSafety: {
    label: 'Delta docs: agentic safety',
    href: 'https://delta.dev/docs/privacy-and-security/agentic-safety',
  },
  deltaPricing: { label: 'Delta pricing', href: 'https://delta.dev/pricing' },
  deltaRoadmap: { label: 'Delta roadmap', href: 'https://delta.dev/roadmap' },
  tangledHome: { label: 'tangled.org', href: 'https://tangled.org/' },
  tangledDocs: {
    label: 'Tangled docs',
    href: 'https://tangled.org/docs/introduction/',
  },
  tangledReport: {
    label: 'Third-party report, October 2026',
    href: 'https://saascity.io/blog/tangled-federated-code-forge-github-alternative-2026',
  },
  gitcafeHome: { label: 'git.cafe', href: 'https://git.cafe/' },
  gitcafeDocs: {
    label: 'GitCafe docs summary',
    href: 'https://git.cafe/llms.txt',
  },
  gitcafePricing: {
    label: 'GitCafe pricing',
    href: 'https://git.cafe/pricing',
  },
} satisfies Record<string, Source>

export const rows: Array<Row> = [
  {
    id: 'rewrites',
    topic: 'Review',
    question:
      'See only what changed since your last review, even after a rebase',
    why: 'Agents rewrite and force-push all day. A reviewer who has to reread the whole change each time stops reading.',
    cells: {
      us: {
        level: 'yes',
        text: 'A change keeps its number through rebases. Patch sets are numbered, any two can be compared, and approvals and comments carry over.',
      },
      github: {
        level: 'partly',
        text: 'Compare links on force-push events, and “changes since last review”, which can lose its place after a rewrite.',
        sources: [
          {
            label: 'Community report',
            href: 'https://dev.to/pyor/re-reviewing-a-pr-after-changes-the-interdiff-problem-26i6',
          },
        ],
      },
      gitlab: {
        level: 'yes',
        text: 'A diff version for each push, comparable from the Changes tab.',
        sources: [src.gitlabVersions],
      },
      bitbucket: {
        level: 'no',
        text: 'Review by commit. A request to compare across a force push was closed as Won’t Fix.',
        sources: [src.bitbucketRewrite],
      },
      forgejo: {
        level: 'unclear',
        text: 'A pull request is its branch. We found no comparison that follows a rewrite.',
      },
      entire: {
        level: 'unclear',
        text: 'Its docs say findings may go stale after a new push. We found nothing on comparing one push with another.',
        sources: [src.entireTrails],
      },
      origin: {
        level: 'unclear',
        text: 'A pull request shows its timeline, commits, checks and files. Comparing across rewrites is not described.',
        sources: [src.originChangelog],
      },
      delta: {
        level: 'partly',
        text: 'A second review notes what changed since the last verdict, and “seen” marks clear when a file changes again.',
        sources: [src.deltaReview],
      },
      tangled: {
        level: 'yes',
        text: 'Each resubmission is a new round, earlier rounds stay readable, and rounds can be compared.',
        sources: [src.tangledHome, src.tangledReport],
      },
      gitcafe: {
        level: 'unclear',
        text: 'Diffs and feedback beside the code. Comparing across rewrites is not described.',
        sources: [src.gitcafeHome],
      },
    },
  },
  {
    id: 'stacks',
    topic: 'Review',
    question: 'Stacked changes that land in order',
    why: 'Small changes are what make agent work reviewable, and small changes that depend on each other need a stack.',
    cells: {
      us: {
        level: 'yes',
        text: 'A stack lands bottom first. Children are rebased onto the result and keep their approvals.',
      },
      github: {
        level: 'yes',
        text: 'Generally available on every plan since October 2026. A stack goes through the merge queue as one group.',
        sources: [src.githubStacks],
      },
      gitlab: {
        level: 'partly',
        text: '`glab stack` is still an experiment. Each merge request targets the one before it.',
        sources: [src.gitlabStacks],
      },
      bitbucket: {
        level: 'no',
        text: 'Merge queues arrived in 2026. We found no stacked pull requests.',
      },
      forgejo: {
        level: 'no',
        text: 'No stacked workflow that we found. AGit flow opens and updates a pull request with a push.',
      },
      entire: {
        level: 'unclear',
        text: 'A trail can hold several changes, even across repositories, but each is reviewed and merged on its own. Order between them is not described.',
        sources: [src.entireTrails],
      },
      origin: {
        level: 'unclear',
        text: 'A third-party guide lists stack commands in the Origin CLI. Cursor’s own pages do not mention stacks.',
        sources: [src.originGuide],
      },
      delta: {
        level: 'unclear',
        text: 'Work happens in threads and subthreads, and a merge skill you write does the landing. Order between threads is not described.',
        sources: [src.deltaReview],
      },
      tangled: {
        level: 'yes',
        text: 'Stacked pull requests for Jujutsu and, since October 2026, plain git.',
        sources: [src.tangledHome, src.tangledReport],
      },
      gitcafe: {
        level: 'yes',
        text: 'A chain of pull requests, each targeting the one below, merged in order.',
        sources: [src.gitcafeHome, src.gitcafeDocs],
      },
    },
  },
  {
    id: 'anyagent',
    topic: 'Agents',
    question: 'Any agent or model, at the model provider’s price',
    why: 'The best agent changes every few months. Being tied to one, or paying a host’s margin on its tokens, adds up.',
    cells: {
      us: {
        level: 'yes',
        text: 'Any harness over the CLI or MCP, with the agent skill. We never sell tokens, so there is nothing to mark up.',
      },
      github: {
        level: 'partly',
        text: 'Copilot, Claude and Codex run in Agent HQ, each session using premium requests on a Copilot plan.',
        sources: [src.githubAgentHq],
      },
      gitlab: {
        level: 'partly',
        text: 'Duo Agent Platform, plus Claude Code and Codex CLI as external agents, paid for in GitLab Credits.',
        sources: [src.gitlabDap],
      },
      bitbucket: {
        level: 'partly',
        text: 'Rovo Dev reviews and runs agent steps in Pipelines, with Rovo Dev seats. Other tools connect through Atlassian’s MCP server.',
        sources: [src.bitbucketPipelines, src.bitbucketMcp],
      },
      forgejo: {
        level: 'no',
        text: 'No agent features. Codeberg’s terms now bar projects that are mostly AI-generated.',
        sources: [src.codebergAi],
      },
      entire: {
        level: 'partly',
        text: 'Claude Code and Codex, on Anthropic, OpenAI and Bedrock models, billed per token at the provider’s published rate.',
        sources: [src.entireLaunch, src.entirePricing],
      },
      origin: {
        level: 'partly',
        text: 'Cursor’s own agents and automations. Other agents are not mentioned.',
        sources: [src.originChangelog, src.originDocs],
      },
      delta: {
        level: 'partly',
        text: 'Your own API keys for free, and Claude through ACP. Codex and others are in progress. Pro sells hosted tokens.',
        sources: [src.deltaPricing, src.deltaRoadmap],
      },
      tangled: {
        level: 'no',
        text: 'Agents can have their own accounts over plain git. The CLI and agent skills are not out yet.',
        sources: [src.tangledHome, src.tangledReport],
      },
      gitcafe: {
        level: 'yes',
        text: 'A hosted MCP server for tools such as Claude and ChatGPT, and a CLI with agent skills. No tokens are sold.',
        sources: [src.gitcafeHome, src.gitcafeDocs],
      },
    },
  },
  {
    id: 'agentrules',
    topic: 'Agents',
    question:
      'Agents have their own scoped access and cannot approve their own work',
    why: 'An agent with a person’s token can do anything that person can, including wave its own change through.',
    cells: {
      us: {
        level: 'yes',
        text: 'Agents are bots with scoped tokens and expiring grants. Policies name agents as their own approver class, and an agent cannot approve its own change.',
      },
      github: {
        level: 'partly',
        text: 'The person who asked Copilot for a change cannot be its required approval. Copilot code review can itself approve, if you turn that on.',
        sources: [src.githubReviewCopilot, src.githubCopilotApproves],
      },
      gitlab: {
        level: 'partly',
        text: 'Agents run as service accounts. We found no approval rule written for agents.',
        sources: [src.gitlabAudit],
      },
      bitbucket: {
        level: 'unclear',
        text: 'The Rovo MCP server can approve and merge pull requests. Rules for agent approvals are not described.',
        sources: [src.bitbucketMcp],
      },
      forgejo: {
        level: 'partly',
        text: 'Bot accounts and scoped tokens, with the usual approval rules. Nothing specific to agents.',
      },
      entire: {
        level: 'partly',
        text: 'Service accounts with a reader, writer or admin role per repository, five per organization. Self-approval is not addressed.',
        sources: [src.entireAccounts],
      },
      origin: {
        level: 'unclear',
        text: 'Access and protection settings are being redesigned, according to a third-party guide.',
        sources: [src.originGuide],
      },
      delta: {
        level: 'no',
        text: 'Delta’s own agent has no permission system yet. Permissions and sandboxing are on its roadmap.',
        sources: [src.deltaSafety, src.deltaRoadmap],
      },
      tangled: {
        level: 'partly',
        text: 'Agents work from their own accounts. Approval rules are not described.',
        sources: [src.tangledHome],
      },
      gitcafe: {
        level: 'partly',
        text: 'Expiring tokens with only the permissions granted, and MCP limited to approved repositories. Self-approval is not addressed.',
        sources: [src.gitcafeDocs],
      },
    },
  },
  {
    id: 'provenance',
    topic: 'Agents',
    question: 'From a line of code to the agent session that wrote it',
    why: 'When agent code breaks, the prompt and the reasoning behind it are the fastest way to the why.',
    cells: {
      us: {
        level: 'yes',
        text: 'Every patch set, review and comment records the run that made it. From any line you reach its commit, change and run, with a transcript scanned for secrets if you keep them.',
      },
      github: {
        level: 'partly',
        text: 'Commits by Copilot’s coding agent link to its session logs. Other agents’ commits do not.',
        sources: [src.githubTrace],
      },
      gitlab: {
        level: 'partly',
        text: 'An audit report of agent sessions, in beta and off by default. Tying commits to sessions is a proposal.',
        sources: [src.gitlabAudit, src.gitlabTraceIssue],
      },
      bitbucket: {
        level: 'unclear',
        text: 'We found nothing on tracing code back to an agent session.',
      },
      forgejo: { level: 'no', text: 'No agent features.' },
      entire: {
        level: 'yes',
        text: 'Its open-source CLI records agent sessions next to each commit, and a change keeps its commits and sessions together.',
        sources: [src.entireCli, src.entireTrails],
      },
      origin: {
        level: 'unclear',
        text: 'Not described.',
        sources: [src.originDocs],
      },
      delta: {
        level: 'yes',
        text: 'From any line you can find the conversation that produced it and every one that touched it since.',
        sources: [src.deltaDb],
      },
      tangled: {
        level: 'unclear',
        text: 'Each edit writes a signed record to its author’s account. Agent sessions are not described.',
        sources: [src.tangledReport],
      },
      gitcafe: {
        level: 'unclear',
        text: 'Not described.',
      },
    },
  },
  {
    id: 'secrets',
    topic: 'Agents',
    question: 'Agents use secrets without seeing their values',
    why: 'An agent that can read a key can leak it, through a log, a prompt injection or a commit.',
    cells: {
      us: {
        level: 'yes',
        text: 'Secrets are committed encrypted. An agent runs commands that have the values, never receives them, and production stays with people.',
      },
      github: {
        level: 'no',
        text: 'Secrets put in the agent’s environment are passed to the agent. A firewall limits where it can send them.',
        sources: [src.githubAgentEnv],
      },
      gitlab: {
        level: 'unclear',
        text: 'GitLab 19 added secrets management. We found nothing on hiding values from agents.',
      },
      bitbucket: {
        level: 'unclear',
        text: 'Not described for agents.',
      },
      forgejo: {
        level: 'no',
        text: 'No agent features. Actions secrets are for CI.',
      },
      entire: {
        level: 'unclear',
        text: 'Service accounts can sign in from CI without a stored secret. Secrets inside an agent’s sandbox are not described.',
        sources: [src.entireAccounts],
      },
      origin: { level: 'unclear', text: 'Not described.' },
      delta: {
        level: 'no',
        text: 'Its docs say the agent has unrestricted access to the machine it runs on.',
        sources: [src.deltaSafety],
      },
      tangled: {
        level: 'unclear',
        text: 'CI secrets exist. Agents are not covered.',
      },
      gitcafe: {
        level: 'unclear',
        text: 'Repository and organization secrets for workflows. Agents are not covered.',
        sources: [src.gitcafeDocs],
      },
    },
  },
  {
    id: 'policy',
    topic: 'Control',
    question: 'Merge rules kept in the repository, reviewed like code',
    why: 'Rules in a settings page change without review and leave no history. Rules in the repository are diffed, approved and kept.',
    cells: {
      us: {
        level: 'yes',
        text: 'Policies are a file in the repository. Changing one is itself a change that needs approval, and a dry run shows what it would block.',
      },
      github: {
        level: 'partly',
        text: 'Rulesets live in settings, with JSON import and export. CODEOWNERS is a file in the repository.',
        sources: [src.githubRulesets],
      },
      gitlab: {
        level: 'partly',
        text: 'Approval policies are YAML, kept in a separate security policy project rather than the repository itself.',
        sources: [src.gitlabPolicies],
      },
      bitbucket: {
        level: 'no',
        text: 'Branch restrictions and merge checks are set in repository settings.',
      },
      forgejo: {
        level: 'partly',
        text: 'Branch protection is in settings. CODEOWNERS is a file in the repository.',
      },
      entire: {
        level: 'partly',
        text: 'Custom review agents can be JSON in the repository. Gates are set per repository in settings, and an open request asks for them as code.',
        sources: [src.entireLaunch, src.entireGatesIssue],
      },
      origin: {
        level: 'unclear',
        text: 'Not described.',
        sources: [src.originDocs],
      },
      delta: {
        level: 'partly',
        text: 'The merge strategy is a skill, and skills can live in the repository. Required approvals are not described.',
        sources: [src.deltaReview, src.deltaSafety],
      },
      tangled: {
        level: 'unclear',
        text: 'CI workflows are files in the repository. Merge rules are not described.',
        sources: [src.tangledReport],
      },
      gitcafe: {
        level: 'no',
        text: 'Rulesets that require reviews and checks, managed in settings.',
        sources: [src.gitcafeDocs],
      },
    },
  },
  {
    id: 'leave',
    topic: 'Control',
    question: 'Mirror out to another host, issues and reviews included',
    why: 'Hosts go down and change hands. A copy that lives elsewhere, with its discussion, is what makes leaving possible.',
    cells: {
      us: {
        level: 'yes',
        text: 'Import from other hosts and mirror back out, one way or two. Issues, changes and releases travel with the code.',
      },
      github: {
        level: 'partly',
        text: 'An importer for code and history. We found no built-in mirror out, so people script `git push --mirror`.',
        sources: [
          {
            label: 'GitHub docs issue',
            href: 'https://github.com/github/docs/issues/44554',
          },
        ],
      },
      gitlab: {
        level: 'partly',
        text: 'Push and pull mirrors for repository contents. Issues and merge requests do not travel with them.',
      },
      bitbucket: {
        level: 'partly',
        text: 'Imports code and history. Pull requests and issues do not come with it, and we found no mirror out.',
        sources: [src.bitbucketImport],
      },
      forgejo: {
        level: 'partly',
        text: 'Migrations can bring issues and pull requests in. Push mirrors send repository contents only.',
      },
      entire: {
        level: 'partly',
        text: 'Mirrors a GitHub repository with GitHub as the source of truth, and can detach. Entire reviews and GitHub reviews stay separate.',
        sources: [src.entireLaunch, src.entireTrails],
      },
      origin: {
        level: 'partly',
        text: 'Two-way sync with GitHub, pull requests and reviews included. GitHub stays the source of truth, and no other host is mentioned.',
        sources: [src.originChangelog],
      },
      delta: {
        level: 'partly',
        text: 'Not a host: it works on your existing git remote, so the code stays there. Threads do not export that we found.',
        sources: [src.deltaReview],
      },
      tangled: {
        level: 'partly',
        text: 'Imports history, branches and tags, not issues or pull requests. No built-in mirror out.',
        sources: [src.tangledReport],
      },
      gitcafe: {
        level: 'yes',
        text: 'Import from GitHub with issues, pull requests and reviews, and sync one way or both. Git mirrors keep a branch in step elsewhere.',
        sources: [src.gitcafeHome, src.gitcafeDocs],
      },
    },
  },
  {
    id: 'ci',
    topic: 'Running code',
    question: 'CI that the host runs for you',
    why: 'Hosted CI is one less thing to set up. Bringing your own runner means you pick the hardware and pay its price.',
    cells: {
      us: {
        level: 'no',
        text: 'No hosted CI, on purpose. Connect any runner: Blacksmith or your own machines today, more planned. No minutes to buy.',
      },
      github: { level: 'yes', text: 'Hosted runners, and self-hosted ones.' },
      gitlab: { level: 'yes', text: 'Hosted runners, and self-managed ones.' },
      bitbucket: {
        level: 'yes',
        text: 'Pipelines on Atlassian’s cloud runners, and self-hosted runners.',
        sources: [src.bitbucketPricing],
      },
      forgejo: {
        level: 'partly',
        text: 'Actions, with runners you run yourself.',
      },
      entire: {
        level: 'partly',
        text: 'Builds run on Buildkite, Depot or your own machines.',
        sources: [src.entireLaunch],
      },
      origin: {
        level: 'partly',
        text: 'Depot or Buildkite connect as apps and run your GitHub Actions workflows.',
        sources: [src.originChangelog],
      },
      delta: {
        level: 'no',
        text: 'An agent can trigger your existing CI provider. Its own builds are a longer-term plan.',
        sources: [src.deltaBeta],
      },
      tangled: {
        level: 'yes',
        text: 'A hosted CI runner, in NixOS microVMs, or your own.',
        sources: [src.tangledDocs],
      },
      gitcafe: {
        level: 'partly',
        text: 'Runs GitHub Actions workflows on hosted Linux machines or your own runners, in beta.',
        sources: [src.gitcafeDocs],
      },
    },
  },
  {
    id: 'free',
    topic: 'Price',
    question: 'A free plan',
    why: 'Free is where most people try a host. We chose a trial instead, and say why.',
    cells: {
      us: {
        level: 'no',
        text: `No. Every plan is paid, with a ${trial.days}-day trial first. Hosting every clone and replica costs us real money.`,
      },
      github: { level: 'yes', text: 'A free plan.' },
      gitlab: { level: 'yes', text: 'A free tier.' },
      bitbucket: {
        level: 'yes',
        text: 'Free for up to 5 users, with 50 build minutes a month.',
        sources: [src.bitbucketPricing],
      },
      forgejo: {
        level: 'yes',
        text: 'Free to run yourself. Codeberg is free, run by a non-profit, and does not take projects that are mostly AI-generated.',
        sources: [src.codebergAi],
      },
      entire: {
        level: 'yes',
        text: 'Hosting, Trails and session storage are free. Agent runs are paid per token.',
        sources: [src.entirePricing],
      },
      origin: {
        level: 'no',
        text: 'Comes with Cursor’s Premium plan and above, not Free or Plus.',
        sources: [src.originDocs],
      },
      delta: {
        level: 'yes',
        text: 'Free with your own keys. Pro is $10 a month with hosted models.',
        sources: [src.deltaPricing],
      },
      tangled: {
        level: 'yes',
        text: 'Hosting and CI are free. We found no paid plan.',
        sources: [src.tangledDocs],
      },
      gitcafe: {
        level: 'yes',
        text: 'Free for public projects. Private repositories are free during the beta.',
        sources: [src.gitcafePricing],
      },
    },
  },
  {
    id: 'selfhost',
    topic: 'Price',
    question: 'Run it on your own servers',
    why: 'Some teams cannot put code on someone else’s machines at all.',
    cells: {
      us: {
        level: 'no',
        text: 'No. Hosted only. Your repositories are plain git, and mirrors keep copies elsewhere.',
      },
      github: { level: 'yes', text: 'GitHub Enterprise Server.' },
      gitlab: { level: 'yes', text: 'Self-managed.' },
      bitbucket: {
        level: 'yes',
        text: 'Data Center, through Atlassian sales.',
        sources: [src.bitbucketPricing],
      },
      forgejo: { level: 'yes', text: 'That is what it is for.' },
      entire: {
        level: 'unclear',
        text: 'Not offered that we found. Hosting is in the US, EU, India or Australia.',
        sources: [src.entireLaunch],
      },
      origin: {
        level: 'unclear',
        text: 'No self-hosted option published that we found.',
      },
      delta: { level: 'unclear', text: 'Not described.' },
      tangled: {
        level: 'yes',
        text: 'Run your own server and CI runner, and keep a federated identity.',
        sources: [src.tangledDocs],
      },
      gitcafe: {
        level: 'unclear',
        text: 'We found self-hosted CI runners only.',
      },
    },
  },
]

/** What the others do better, said plainly. */
export const behind = [
  'A free plan. Most of the others have one; we have a trial.',
  'Running it on your own servers: GitHub, GitLab, Bitbucket, Forgejo and Tangled all let you.',
  'CI the host runs for you, with no runner to bring.',
  'Stacked pull requests are now on every GitHub plan, and Tangled and GitCafe have them too, with Jujutsu support.',
  'Years of ecosystem: integrations, answers, and people who already know the product.',
]

/** Looked at, and left out of the table, with the reason. */
export const leftOut: Array<{ name: string; href: string; why: string }> = [
  {
    name: 'Graphite',
    href: 'https://graphite.com/',
    why: 'stacked pull requests and AI review on top of GitHub, now part of Cursor',
  },
  {
    name: 'Mesa and CodeRabbit',
    href: 'https://mesa.dev/',
    why: 'AI review that runs on another host’s pull requests',
  },
  {
    name: 'Pierre Code Storage',
    href: 'https://code.storage/',
    why: 'git storage for platforms to build on, not a host for teams',
  },
  {
    name: 'Gerrit, SourceHut, Radicle and Azure DevOps',
    href: 'https://www.gerritcodereview.com/',
    why: 'left out to keep the table readable. We have not checked them row by row',
  },
]

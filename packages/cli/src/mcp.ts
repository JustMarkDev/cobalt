/**
 * The cobalt MCP server. Every tool runs the matching `cb` command with
 * --json, so an agent gets exactly what the CLI and the web page give a person:
 * same data, same blockers, same error codes and hints.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { run } from './main'
import { skillFile } from './skill'
import { schema } from './schema'
import { version } from './help'
import { declared, makeClient } from './client'
import type { Catalogue } from './operations'
import { callOperation, catalogue } from './operations'
import {
  TIMELINE_LIMIT,
  advertiseCompact,
  fitText,
  noteContextLimits,
  pageTimeline,
} from './mcp-fit'
import type { ApiClient } from './client'
import type { CallToolResult } from '@modelcontextprotocol/server'

const instructions = `cobalt hosts git repositories, reviews changes and lands them under policy.
Call get_context first: it lists open changes, what blocks each, open issues and the env schema.
Every tool returns JSON. A failed call sets isError and returns {error:{code,message,hint}}: read the hint, do not retry blindly.
land_change fails with code policy_blocked when requirements are missing. Stop and report them; you cannot approve your own change.
Secret values are never returned. Only names and kinds.
Prefer dry_run before anything that changes state.
The named tools cover the daily work. For anything else, search_operations finds the API operation and call_operation runs it.`

async function cb(argv: Array<string>, client?: ApiClient) {
  let out = ''
  let err = ''
  const code = await run(
    [...argv, '--json'],
    { out: (s) => (out += s), err: (s) => (err += s) },
    { client },
  )
  return { code, out, err }
}

const repoArg = z
  .string()
  .optional()
  .describe('owner/name. Required unless the server was started in a clone.')

type Hint = {
  readOnly?: boolean
  idempotent?: boolean
  destructive?: boolean
  /** Exit codes that carry a successful answer, such as policy blocked (5). */
  allowExit?: Array<number>
}

/**
 * `client` is the caller's own: over HTTP it carries the token the request
 * arrived with, so every tool is checked against that token's scopes.
 */
/** A client's name as a receipt label: plain, printable, short. */
const cleanName = (raw: string | undefined) => {
  const t = raw?.trim().slice(0, 80)
  return t && /^[\p{L}\p{N} ._:+/()@-]+$/u.test(t) ? t : null
}

export function createSxMcpServer(
  options: { client?: ApiClient } = {},
): McpServer {
  const server = new McpServer({ name: 'cobalt', version }, { instructions })

  // The connecting client names the tool on every receipt (an orchestrator's
  // CB_TOOL wins). A hosted server labels only its own client; over stdio the
  // process serves one client, so the label is the process's.
  server.server.oninitialized = () => {
    const name = cleanName(server.server.getClientVersion()?.name)
    if (!name || process.env.CB_TOOL) return
    if (options.client) options.client.tool = name
    else declared.tool = name
  }

  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    cb: (a: unknown) => Promise<CallToolResult>,
  ) => void

  /**
   * While an agent works on a change, it is in that change's room, so the
   * people reviewing it see it there. One heartbeat per change per interval,
   * sent before the call and never in its way.
   */
  const lastBeat = new Map<string, number>()
  const lookingAt = async (args: Array<string>) => {
    const [group, sub] = args
    const id = args.at(2) ?? ''
    if (group !== 'change' || sub === 'presence' || !/^#?\d+$/.test(id)) return
    const at = args.indexOf('-R')
    const where = at >= 0 ? ['-R', args[at + 1]] : []
    const key = `${where.join(' ')}#${id}`
    if (Date.now() - (lastBeat.get(key) ?? 0) < 15_000) return
    lastBeat.set(key, Date.now())
    await cb(['change', 'presence', id, '--here', ...where], options.client)
  }

  const tool = <TShape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: TShape,
    argv: (a: z.infer<z.ZodObject<TShape>>) => Array<string>,
    hint: Hint = {},
    // What the agent gets: by default the CLI's JSON, kept within budget.
    shapeAnswer: (out: string, a: z.infer<z.ZodObject<TShape>>) => string = (
      out,
    ) => fitText(out),
  ) => {
    // The SDK's generic handler types do not survive a shared helper, so the
    // schema is the contract and the handler is checked by the tests.
    register(
      name,
      {
        description,
        inputSchema: advertiseCompact(z.object(shape)),
        annotations: {
          readOnlyHint: hint.readOnly ?? false,
          idempotentHint: hint.idempotent ?? hint.readOnly ?? false,
          destructiveHint: hint.destructive ?? false,
          openWorldHint: false,
        },
      },
      async (a: unknown): Promise<CallToolResult> => {
        const input = a as z.infer<z.ZodObject<TShape>>
        const args = argv(input)
        await lookingAt(args)
        const r = await cb(args, options.client)
        if (
          r.code === 0 ||
          (hint.allowExit?.includes(r.code) && r.out.trim() !== '')
        )
          return {
            content: [
              {
                type: 'text' as const,
                text: shapeAnswer(r.out || r.err, input),
              },
            ],
          }
        return {
          isError: true,
          content: [{ type: 'text' as const, text: fitText(r.err || r.out) }],
        }
      },
    )
  }

  const repo = (a: { repo?: string }) => (a.repo ? ['-R', a.repo] : [])
  const dry = (a: { dry_run?: boolean }) => (a.dry_run ? ['--dry-run'] : [])
  const dryArg = z
    .boolean()
    .optional()
    .describe('Report what would happen and change nothing.')

  tool(
    'list_accounts',
    'Every account you can act as (a person and their organizations) with your role in each. Commands act as the owner of the repository you name; set CB_ACCOUNT for the server to act as another.',
    {},
    () => ['account', 'list'],
    { readOnly: true },
  )
  tool(
    'get_context',
    'Start here. Repository, default branch, open changes with their blockers, open issues, policy summary and the env schema (names only).',
    { repo: repoArg },
    (a) => ['context', ...repo(a)],
    { readOnly: true },
    (out) => noteContextLimits(out),
  )
  tool(
    'list_changes',
    'Open changes in a repository. Set all to include landed ones.',
    { repo: repoArg, all: z.boolean().optional() },
    (a) => ['change', 'list', ...repo(a), ...(a.all ? ['--all'] : [])],
    { readOnly: true },
  )
  tool(
    'get_change',
    'One change and every requirement blocking it from landing. The same status the change page shows.',
    { repo: repoArg, id: z.string().describe('Change number, like 216.') },
    (a) => ['change', 'view', a.id, ...repo(a)],
    { readOnly: true },
  )
  tool(
    'create_change',
    'Create a change from a branch. Calling it again for the same branch adds a patch set instead of a duplicate. When it adds a patch set, `addresses` names the review threads it fixes (comment ids that start a thread): they are marked addressed in the same write and their authors are told. Addressed is not resolved.',
    {
      repo: repoArg,
      branch: z.string(),
      title: z.string(),
      draft: z.boolean().optional(),
      base: z.string().optional(),
      addresses: z
        .array(z.string())
        .optional()
        .describe('Comment ids (cmt_…) of the threads this patch set fixes.'),
      dry_run: dryArg,
    },
    (a) => [
      'change',
      'create',
      '--branch',
      a.branch,
      '--title',
      a.title,
      ...(a.draft ? ['--draft'] : []),
      ...(a.base ? ['--base', a.base] : []),
      ...(a.addresses?.length ? ['--addresses', a.addresses.join(',')] : []),
      ...repo(a),
      ...dry(a),
    ],
    { idempotent: true },
  )
  tool(
    'get_timeline',
    `The story of a change or an issue, oldest first: patch sets, review comments, reviews, findings, checks, evidence, state changes and, for an issue, the changes that fix it. Each entry has its receipt: the machine, tool and model that wrote it. Answers the newest ${TIMELINE_LIMIT} entries; when there are more, earlier says how to read them.`,
    {
      repo: repoArg,
      kind: z.enum(['change', 'issue']),
      id: z.string().describe('The change or issue number, like 216.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          `How many entries, counted from the newest. Default ${TIMELINE_LIMIT}.`,
        ),
      before: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'From earlier in an answer: the entries before this position.',
        ),
    },
    (a) => [a.kind, 'timeline', a.id, ...repo(a)],
    { readOnly: true },
    (out, a) => pageTimeline(out, { limit: a.limit, before: a.before }),
  )
  tool(
    'get_presence',
    'Who else has a change or an issue open right now, and the file each is on. Working on a change through these tools puts you in its room too.',
    {
      repo: repoArg,
      kind: z.enum(['change', 'issue']),
      id: z.string().describe('The change or issue number, like 216.'),
    },
    (a) => [a.kind, 'presence', a.id, ...repo(a)],
    { readOnly: true },
  )
  tool(
    'write_change_guide',
    'Write the guide reviewers read a change by: a summary, then every file worth reading in order, each with why and how risky. It replaces the guide there was, and records the run that wrote it. Call it after pushing a patch set you know well.',
    {
      repo: repoArg,
      id: z.string().describe('Change number, like 216.'),
      summary: z.string().describe('What the change does, for a reviewer.'),
      order: z
        .array(
          z.object({
            path: z.string(),
            why: z.string().describe('Why to read it, and what to look for.'),
            risk: z.enum(['low', 'medium', 'high']),
          }),
        )
        .describe(
          'Files of the newest patch set, each once, in reading order.',
        ),
      dry_run: dryArg,
    },
    (a) => [
      'change',
      'guide',
      a.id,
      '--set',
      JSON.stringify({ summary: a.summary, order: a.order }),
      ...repo(a),
      ...dry(a),
    ],
    { idempotent: true },
  )
  tool(
    'land_change',
    'Land a change if policy allows. Fails with policy_blocked and lists what is missing. Do not work around it.',
    { repo: repoArg, id: z.string(), dry_run: dryArg },
    (a) => ['change', 'land', a.id, ...repo(a), ...dry(a)],
    { destructive: true },
  )
  tool(
    'check_policy',
    'Whether a change meets every policy, and which requirement asks for what.',
    { repo: repoArg, change: z.string() },
    (a) => ['policy', 'explain', a.change, ...repo(a)],
    { readOnly: true, allowExit: [5] },
  )
  tool(
    'list_issues',
    'Issues, open by default.',
    { repo: repoArg, state: z.enum(['open', 'closed', 'all']).optional() },
    (a) => [
      'issue',
      'list',
      ...repo(a),
      ...(a.state ? ['--state', a.state] : []),
    ],
    { readOnly: true },
  )
  tool(
    'create_issue',
    'Open an issue. The same open title returns the existing issue.',
    {
      repo: repoArg,
      title: z.string(),
      labels: z.array(z.string()).optional(),
      dry_run: dryArg,
    },
    (a) => [
      'issue',
      'create',
      '--title',
      a.title,
      ...(a.labels?.length ? ['--label', a.labels.join(',')] : []),
      ...repo(a),
      ...dry(a),
    ],
    { idempotent: true },
  )
  tool(
    'close_issue',
    'Close an issue.',
    { repo: repoArg, number: z.number().int(), dry_run: dryArg },
    (a) => ['issue', 'close', String(a.number), ...repo(a), ...dry(a)],
    { idempotent: true },
  )
  tool(
    'list_env',
    'Environment variables: names, kinds and whether each environment has a value. Never values.',
    {
      repo: repoArg,
      env: z.enum(['development', 'preview', 'production']).optional(),
    },
    (a) => ['env', 'list', ...repo(a), ...(a.env ? ['--env', a.env] : [])],
    { readOnly: true },
  )
  tool(
    'list_env_confirmations',
    'Your production confirmations on this repository: pending ones with the link where the person confirms, and live ones with their expiry. Development and preview values need none: on the repository team, run commands with `cb env run --env development -- <command>`; values reach that process, never you.',
    { repo: repoArg },
    (a) => ['env', 'confirmations', ...repo(a)],
    { readOnly: true },
  )
  tool(
    'list_mirrors',
    'Copies of the repository on other hosts and whether each is in sync.',
    { repo: repoArg },
    (a) => ['mirror', 'list', ...repo(a)],
    { readOnly: true },
  )
  tool(
    'sync_mirror',
    'Sync one mirror now.',
    { repo: repoArg, id: z.string() },
    (a) => ['mirror', 'sync', a.id, ...repo(a)],
    { idempotent: true },
  )
  tool(
    'import_repository',
    'Bring a repository in from GitHub, GitLab, Codeberg or Gitea with its whole history. It keeps pulling from there through a mirror. Calling it again returns the one already imported.',
    {
      host: z.enum(['github', 'gitlab', 'codeberg', 'gitea']),
      slug: z.string().describe('owner/name on that host.'),
      as: z
        .string()
        .optional()
        .describe(
          'name or owner/name here. Default: its name, in the account you act as.',
        ),
      private: z.boolean().optional(),
      dry_run: dryArg,
    },
    (a) => [
      'import',
      a.host,
      a.slug,
      ...(a.as ? ['--as', a.as] : []),
      ...(a.private ? ['--private'] : []),
      ...dry(a),
    ],
    { idempotent: true },
  )
  tool(
    'hand_off',
    'Build the prompt for an issue, a change or a failing pipeline run and the command that hands it to an orchestrator (T3 Code, or boat). cobalt starts no agent itself.',
    {
      repo: repoArg,
      subject: z
        .string()
        .describe(
          'An issue or change number, like 4 or 216, or a pipeline run as run:1839.',
        ),
      to: z.enum(['t3', 'boat']).optional(),
    },
    (a) => ['handoff', a.subject, ...repo(a), ...(a.to ? ['--to', a.to] : [])],
    { readOnly: true },
  )

  // Every operation, for what the named tools do not cover.
  let own: ApiClient | undefined
  const client = () => options.client ?? (own ??= makeClient())
  const answer = async (
    work: () => Promise<unknown>,
  ): Promise<CallToolResult> => {
    try {
      const value = await work()
      return {
        content: [{ type: 'text', text: fitText(JSON.stringify(value)) }],
      }
    } catch (e) {
      const err = e as {
        code?: string
        message?: string
        hint?: string
        problem?: Record<string, unknown>
      }
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: {
                ...err.problem,
                code: err.code ?? 'internal',
                message: err.message ?? String(e),
                hint: err.hint,
              },
            }),
          },
        ],
      }
    }
  }
  register(
    'search_operations',
    {
      description:
        'Find an API operation by what it does, such as "label delete" or "webhook deliveries". Give id to get one operation in full: its parameters, body schema, safety and scopes. Then run it with call_operation.',
      inputSchema: advertiseCompact(
        z.object({
          query: z
            .string()
            .optional()
            .describe('Words to match. Every word must match.'),
          id: z
            .string()
            .optional()
            .describe(
              'An operation id, like issues.create, for its full description.',
            ),
          safety: z.enum(['read', 'write', 'destructive']).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
      ),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (a) =>
      answer(async () => {
        const { query, id, safety, limit } = a as {
          query?: string
          id?: string
          safety?: string
          limit?: number
        }
        const cat: Catalogue = await catalogue(client())
        if (id) {
          const op = cat.get(id)
          if (op) return cat.describe(op)
        }
        const found = cat.search(query ?? id ?? '', { safety, limit })
        return {
          total: cat.ops.length,
          operations: found.map((op) => cat.brief(op)),
          ...(id
            ? { note: `There is no operation ${id}; these are close.` }
            : {}),
        }
      }),
  )
  register(
    'call_operation',
    {
      description:
        'Run any API operation by id, as the token this server holds. Path and query parameters go in params, the request in body. A destructive operation needs confirm: true unless dry_run is set. Answers {status, data}; a refusal carries the API error code and hint. A policy write (policy.*) in a repository whose rules live in .source/policy/ answers status 202 with a policy_proposal: a change waiting for review, not applied. Report its change number; do not retry.',
      inputSchema: advertiseCompact(
        z.object({
          id: z.string().describe('The operation id from search_operations.'),
          params: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe('Path and query parameters, by name.'),
          body: z.unknown().optional().describe('The JSON request body.'),
          dry_run: dryArg,
          confirm: z
            .boolean()
            .optional()
            .describe(
              'Required for a destructive operation that is not a dry run.',
            ),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    (a) =>
      answer(() =>
        callOperation(client(), a as Parameters<typeof callOperation>[1]),
      ),
  )

  server.registerResource(
    'skill',
    'cb://skill',
    {
      title: 'How to use cobalt and cb',
      description: 'The agent skill: rules, exit codes and the workflow.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skillFile }],
    }),
  )
  server.registerResource(
    'commands',
    'cb://commands',
    {
      title: 'Every cb command',
      description: 'The CLI as JSON: arguments, examples and exit codes.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ commands: schema }, null, 2),
        },
      ],
    }),
  )

  return server
}

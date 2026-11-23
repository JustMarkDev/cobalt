import { TRIGGERS_DIR } from './trigger-file'
import type { FileError, Trigger } from './trigger-file'

/**
 * A repository's triggers as the API shows them: what is in force, the files
 * they come from, why the newest files did not read (if they did not), and
 * what each trigger did lately. Shared by both domains.
 */
export function presentTriggers(
  repo: string,
  html: string,
  branch: string,
  t: {
    files: Record<string, string>
    sha: string
    set: Array<Trigger>
    errors: Array<FileError>
  } | null,
  runs: Array<{
    triggerId: string
    eventSequence: number
    run: number | null
    state: 'started' | 'failed' | 'capped'
    error: string | null
    at: number
  }>,
) {
  const link = (file: string) => `${html}/${repo}/blob/${branch}/${file}`
  return {
    object: 'trigger_set' as const,
    repo,
    path: TRIGGERS_DIR,
    sha: t?.sha ?? null,
    files: Object.keys(t?.files ?? {})
      .sort()
      .map((path) => ({ path, html_url: link(path) })),
    triggers: (t?.set ?? []).map((x) => ({
      id: x.id,
      on: [...x.on],
      filter: {
        paths: x.filter.paths,
        labels: x.filter.labels,
        actor: x.filter.actor,
        model: x.filter.model,
      },
      action: { run: x.run },
      file: x.file,
      html_url: link(x.file),
    })),
    errors: (t?.errors ?? []).map((e) => ({
      file: e.file,
      path: e.path,
      line: e.line,
      message: e.message,
    })),
    recent: [...runs]
      .sort((a, b) => b.at - a.at || b.eventSequence - a.eventSequence)
      .slice(0, 20)
      .map((r) => ({
        trigger: r.triggerId,
        event_sequence: r.eventSequence,
        state: r.state,
        run: r.run,
        error: r.error,
        at: new Date(r.at).toISOString(),
      })),
  }
}

import { parse } from 'yaml'

export type RunsOn = {
  jobs: Map<string, Array<string>>
  warnings: Array<string>
}

const label = (x: unknown) =>
  typeof x === 'string' && x.trim() ? x.trim().toLowerCase() : null

export function runsOnOf(yamlText: string): RunsOn {
  const jobs = new Map<string, Array<string>>()
  const warnings: Array<string> = []
  let doc: unknown
  try {
    doc = parse(yamlText)
  } catch (e) {
    warnings.push(
      `The workflow file does not read as YAML: ${(e as Error).message.split('\n')[0]}`,
    )
    return { jobs, warnings }
  }
  const all =
    doc && typeof doc === 'object'
      ? (doc as Record<string, unknown>).jobs
      : undefined
  if (!all || typeof all !== 'object' || Array.isArray(all))
    return { jobs, warnings }
  for (const [key, job] of Object.entries(all as Record<string, unknown>)) {
    if (!job || typeof job !== 'object') continue
    const j = job as Record<string, unknown>
    const raw = j['runs-on']
    let labels: Array<string> = []
    if (raw === undefined || raw === null) labels = []
    else if (typeof raw === 'string') labels = label(raw) ? [label(raw)!] : []
    else if (Array.isArray(raw) && raw.every((x) => label(x) !== null))
      labels = [...new Set(raw.map((x) => label(x)!))]
    else
      warnings.push(
        `Job ${key}: runs-on is not a label or a list of labels, so any runner may take it.`,
      )
    jobs.set(key, labels)
    if (typeof j.name === 'string' && j.name && !jobs.has(j.name))
      jobs.set(j.name, labels)
  }
  return { jobs, warnings }
}

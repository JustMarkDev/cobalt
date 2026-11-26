/**
 * The commands a repository page offers for installing the project.
 *
 * They come from the owners first (the repository's `install` field, one
 * command per line), then from the README's code blocks. Nothing is made up:
 * a desktop app with no package anywhere shows no commands at all.
 */

export type Install = { label: string; command: string }

const MAX = 6

/** A command that installs the project itself, and the tab it goes under. */
const KINDS: Array<[string, RegExp]> = [
  ['brew', /^brew\s+(install|tap)\s+\S/],
  ['npm', /^npm\s+(install|i)\s+(-g|--global)\s+\S/],
  ['npx', /^npx\s+\S/],
  ['pnpm', /^pnpm\s+(add|install|i)\s+(-g|--global)\s+\S/],
  ['bun', /^bun\s+(add|install|i)\s+(-g|--global)\s+\S/],
  ['bunx', /^bunx\s+\S/],
  ['yarn', /^yarn\s+global\s+add\s+\S/],
  ['cargo', /^cargo\s+(install|binstall)\s+\S/],
  ['go', /^go\s+install\s+\S+@\S+/],
  ['pipx', /^pipx\s+install\s+\S/],
  ['uv', /^uv\s+tool\s+install\s+\S/],
  ['pip', /^pip3?\s+install\s+(?!-r\b|-e\b|\.)\S/],
  ['winget', /^winget\s+install\s+\S/],
  ['scoop', /^scoop\s+install\s+\S/],
  ['choco', /^choco\s+install\s+\S/],
  ['flatpak', /^flatpak\s+install\s+\S/],
  ['snap', /^(sudo\s+)?snap\s+install\s+\S/],
  ['AUR', /^(yay|paru)\s+-S\s+\S/],
  ['nix', /^nix\s+(profile\s+install|run|shell)\s+\S/],
  ['docker', /^docker\s+(run|pull)\s+\S/],
  ['script', /^(curl|wget)\s.*\|\s*(sudo\s+)?(sh|bash|zsh)\b/],
  ['script', /^(iwr|irm|Invoke-RestMethod|Invoke-WebRequest)\s.*\|\s*iex\b/i],
]

/** Headings whose code blocks are for people working on the code, not using it. */
const FOR_CONTRIBUTORS =
  /contribut|develop|build|from source|hacking|testing|local setup|release process/i

const labelOf = (command: string): string | null =>
  KINDS.find(([, re]) => re.test(command))?.[0] ?? null

const clean = (line: string) =>
  line
    .trim()
    .replace(/^(\$|>|PS>)\s+/, '')
    .trim()

/** Commands the owners typed, one per line. Unknown tools get their first word. */
export function ownerInstalls(text: string | null | undefined): Array<Install> {
  const out: Array<Install> = []
  for (const raw of (text ?? '').split('\n')) {
    const command = clean(raw)
    if (!command || command.startsWith('#')) continue
    const label = labelOf(command) ?? command.split(/\s+/)[0]
    out.push({ label, command })
  }
  return unique(out)
}

/** Install commands found in a README's fenced code blocks. */
export function readmeInstalls(markdown: string): Array<Install> {
  const out: Array<Install> = []
  let skipping = false
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length)
        fence = null
      else if (!skipping) {
        const command = clean(line)
        const label = labelOf(command)
        if (label) out.push({ label, command })
      }
      continue
    }
    if (open) {
      fence = open[1]
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) skipping = FOR_CONTRIBUTORS.test(heading[1])
  }
  return unique(out)
}

/** The owners' commands when they set any, otherwise the README's. */
export function installsFor(
  install: string | null | undefined,
  readme: string,
): Array<Install> {
  const own = ownerInstalls(install)
  return own.length > 0 ? own : readmeInstalls(readme)
}

/** One command per tab, so two `brew` lines don't make two `brew` tabs. */
function unique(list: Array<Install>): Array<Install> {
  const seen = new Set<string>()
  const out: Array<Install> = []
  for (const i of list) {
    if (seen.has(i.label)) continue
    seen.add(i.label)
    out.push(i)
    if (out.length === MAX) break
  }
  return out
}

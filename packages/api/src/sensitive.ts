/**
 * Paths that protect the repository: its policy, whatever configures CI or
 * code owners, and its environment schema. A change that touches one never
 * lands by itself, so no one can loosen the rules or swap the checks on the
 * way in. Generous on purpose: a false match only means a person presses Land.
 */
const SENSITIVE = [
  /^\.source\//,
  // GitHub, GitLab, Forgejo, Gitea: workflows, actions, CODEOWNERS, settings.
  /^\.(github|gitlab|forgejo|gitea)\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.woodpecker(\.ya?ml|\/)/,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.drone\.ya?ml$/,
  /^\.travis\.ya?ml$/,
  /^(azure|bitbucket)-pipelines\.ya?ml$/,
  /^Jenkinsfile$/,
  /^\.cirrus\.ya?ml$/,
  /^\.?appveyor\.ya?ml$/,
  /^bitrise\.ya?ml$/,
  /^\.semaphore\//,
  /^\.buildkite\.ya?ml$/,
  /(^|\/)CODEOWNERS$/,
  /(^|\/)\.env\.schema$/,
]

export function isSensitivePath(path: string): boolean {
  // Case folded: a case-insensitive checkout treats `.GitHub/` as `.github/`.
  const p = path.replace(/\/+/g, '/').replace(/^\.\//, '')
  return SENSITIVE.some((re) => re.test(p) || re.test(p.toLowerCase()))
}

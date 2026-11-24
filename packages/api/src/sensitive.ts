const SENSITIVE = [
  /^\.source\//,
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
  const p = path.replace(/\/+/g, '/').replace(/^\.\//, '')
  return SENSITIVE.some((re) => re.test(p) || re.test(p.toLowerCase()))
}

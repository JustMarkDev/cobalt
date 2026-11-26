// Someone imported from a git provider has a handle such as
// `octocat@github`, which no account here can take. Pages show the login
// alone; the provider is shown next to it where it matters.
const PROVIDER = /@(github|gitlab|codeberg|gitea)$/

export const shownHandle = (handle: string) => handle.replace(PROVIDER, '')

export const providerOf = (handle: string) =>
  (PROVIDER.exec(handle)?.[1] as
    | 'github'
    | 'gitlab'
    | 'codeberg'
    | 'gitea'
    | undefined) ?? null

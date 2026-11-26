// Which computer a release file is for, read from its name. Files that are
// not something a person installs (signatures, checksums, updater manifests
// and updater bundles) are for no one and are left on the provider.

export type AssetTarget = {
  platform: 'macos' | 'windows' | 'linux'
  arch: string
}

const NOT_INSTALLABLE =
  /\.(sig|asc|sha256|sha512|md5|pem|json|txt|yml|yaml|blockmap)$|(^|[._-])(checksums?|sha256sums)([._-]|$)|\.app\.tar\.gz$|\.(nsis|msi)\.zip$|\.appimage\.tar\.gz$/i

const archOf = (n: string): string =>
  /universal/i.test(n)
    ? 'universal'
    : /aarch64|arm64|armv8/i.test(n)
      ? 'arm64'
      : /x86_64|amd64|x64|win64/i.test(n)
        ? 'x64'
        : /i[3-6]86|x86|win32/i.test(n)
          ? 'x86'
          : ''

export function assetTarget(name: string): AssetTarget | null {
  const n = name.toLowerCase()
  if (NOT_INSTALLABLE.test(n)) return null
  const platform: AssetTarget['platform'] | null =
    /\.(dmg|pkg)$/.test(n) || /(darwin|macos|osx|apple)/.test(n)
      ? 'macos'
      : /\.(exe|msi|msix|appx)$/.test(n) || /(windows|win32|win64)/.test(n)
        ? 'windows'
        : /\.(appimage|deb|rpm|flatpak|snap)$/.test(n) || /linux/.test(n)
          ? 'linux'
          : null
  if (!platform) return null
  let arch = archOf(n)
  // A Mac file with no architecture named runs on both.
  if (!arch) arch = platform === 'macos' ? 'universal' : 'x64'
  return { platform, arch }
}

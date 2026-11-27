// `curl -fsSL https://cobaltforge.dev/install.sh | sh`: cb as one binary for
// this machine, from the latest CLI release, checked against its SHA-256. It
// needs nothing else: Varlock and the MCP server are inside cb.

/** Where the CLI releases are published. */
export const CLI_RELEASES = 'https://github.com/JustMarkDev/cobalt/releases'

/** The binaries a release carries, by `uname -s`/`uname -m` as the script sees them. */
export const CLI_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'windows-x64',
] as const

export const installCommand = (origin: string) =>
  `curl -fsSL ${origin}/install.sh | sh`

export const installCommandWindows = (origin: string) =>
  `irm ${origin}/install.ps1 | iex`

/** The POSIX installer. CB_VERSION picks a release, CB_INSTALL a directory. */
export function installSh(origin: string): string {
  return `#!/bin/sh
# Installs cb, the cobalt command line: ${installCommand(origin)}
# CB_VERSION=0.2.0 picks a release; CB_INSTALL=/some/dir picks where it goes.
set -eu

fail() { printf 'cb install: %s\\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "$(uname -s) is not supported here; on Windows run: ${installCommandWindows(origin)}" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "$(uname -m) processors are not supported yet." ;;
esac
# Rosetta: an Intel shell on Apple silicon still gets the native binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="cb-$os-$arch"
if [ -n "\${CB_VERSION:-}" ]; then
  base="${CLI_RELEASES}/download/cli-v\${CB_VERSION#v}"
else
  base="${CLI_RELEASES}/latest/download"
fi
dir="\${CB_INSTALL:-$HOME/.cobalt/bin}"
mkdir -p "$dir"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
command -v curl >/dev/null 2>&1 || fail "curl is needed to download cb."
printf 'Downloading %s...\\n' "$asset"
curl -fSL --progress-bar "$base/$asset" -o "$tmp/cb" || fail "could not download $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download the checksums."

want="$(grep " $asset\\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  have="$(sha256sum "$tmp/cb" | cut -d' ' -f1)"
else
  have="$(shasum -a 256 "$tmp/cb" | cut -d' ' -f1)"
fi
[ -n "$want" ] && [ "$want" = "$have" ] || fail "the download does not match its checksum; nothing was installed."

chmod +x "$tmp/cb"
mv "$tmp/cb" "$dir/cb"
ln -sf cb "$dir/cobalt"
printf 'Installed %s to %s/cb\\n' "$("$dir/cb" --version)" "$dir"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    case "\${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      */fish) rc="" ; printf 'Add it to your PATH: fish_add_path %s\\n' "$dir" ;;
      *) rc="$HOME/.profile" ;;
    esac
    if [ -n "$rc" ]; then
      line="export PATH=\\"$dir:\\$PATH\\""
      grep -qsF "$line" "$rc" || printf '\\n# cobalt\\n%s\\n' "$line" >> "$rc"
      printf 'Added %s to your PATH in %s. Open a new terminal, or run: %s\\n' "$dir" "$rc" "$line"
    fi
    ;;
esac
printf 'Next: cb auth login\\n'
`
}

/** The PowerShell installer, for Windows. */
export function installPs1(origin: string): string {
  return `# Installs cb, the cobalt command line: ${installCommandWindows(origin)}
$ErrorActionPreference = 'Stop'
$asset = 'cb-windows-x64.exe'
$base = if ($env:CB_VERSION) { "${CLI_RELEASES}/download/cli-v$($env:CB_VERSION.TrimStart('v'))" } else { '${CLI_RELEASES}/latest/download' }
$dir = if ($env:CB_INSTALL) { $env:CB_INSTALL } else { Join-Path $HOME '.cobalt\\bin' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset..."
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp 'cb.exe') -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing).Content
  $want = ($sums -split "\`n" | Where-Object { $_ -match " $asset$" } | ForEach-Object { ($_ -split ' ')[0] })
  $have = (Get-FileHash (Join-Path $tmp 'cb.exe') -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want -ne $have) { throw 'The download does not match its checksum; nothing was installed.' }
  Move-Item -Force (Join-Path $tmp 'cb.exe') (Join-Path $dir 'cb.exe')
  Copy-Item -Force (Join-Path $dir 'cb.exe') (Join-Path $dir 'cobalt.exe')
} finally { Remove-Item -Recurse -Force $tmp }
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', "$dir;$path", 'User')
  Write-Host "Added $dir to your PATH. Open a new terminal."
}
Write-Host "Installed $(& (Join-Path $dir 'cb.exe') --version) to $dir\\cb.exe"
Write-Host 'Next: cb auth login'
`
}

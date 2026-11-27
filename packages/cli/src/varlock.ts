// Varlock ships inside cb: nobody installs it separately. cb re-runs itself
// with CB_AS_VARLOCK set, and that process is varlock's own CLI. The marker
// is dropped at once, so the command varlock runs (which may well be cb) is
// itself again. Telemetry, the one thing that would re-run varlock, is off.
import { dirname, join } from 'node:path'

export const AS_VARLOCK = 'CB_AS_VARLOCK'

/** The command that runs the varlock bundled with this cb. */
export function varlockCommand(): Array<string> {
  // Compiled: cb itself. From source: bun and this checkout's main.ts.
  return Bun.isStandaloneExecutable
    ? [process.execPath]
    : [process.execPath, join(import.meta.dir, 'main.ts')]
}

/** The environment that makes varlockCommand() act as varlock. */
export const varlockEnv = {
  [AS_VARLOCK]: '1',
  // cb sends nothing anywhere on the user's behalf.
  VARLOCK_TELEMETRY_DISABLED: 'true',
}

/** Be varlock: its CLI reads process.argv itself. */
export async function beVarlock(): Promise<void> {
  delete process.env[AS_VARLOCK]
  try {
    // A literal path, so `bun build --compile` puts varlock in the binary.
    await import('../node_modules/varlock/dist/cli/cli-executable.mjs')
  } catch (e) {
    // Installed from npm, where varlock may be hoisted elsewhere.
    if (Bun.isStandaloneExecutable) throw e
    await import(
      join(dirname(require.resolve('varlock')), 'cli', 'cli-executable.mjs')
    )
  }
}

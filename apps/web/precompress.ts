/**
 * Runs after `vp build`: writes a brotli (`.br`) and a gzip (`.gz`) copy next
 * to every built file worth compressing, at the best setting of each. The
 * files never change once built, so `server.ts` sends these copies and
 * compresses nothing for them while it runs.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { MIN_BYTES, compressible } from './compress'

const br = promisify(brotliCompress)
const gz = promisify(gzip)
const root = join(import.meta.dir, 'dist', 'client')

const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((d) => d.isFile() && !/\.(br|gz)$/.test(d.name))
  .map((d) => join(d.parentPath, d.name))

let before = 0
let after = 0
let count = 0
await Promise.all(
  files.map(async (path) => {
    const file = Bun.file(path)
    if (!compressible(file.type) || file.size < MIN_BYTES) return
    const bytes = await file.bytes()
    const [b, g] = await Promise.all([
      br(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      }),
      gz(bytes, { level: 9 }),
    ])
    // A copy that is not smaller is not worth sending.
    if (b.byteLength < bytes.byteLength) await Bun.write(`${path}.br`, b)
    if (g.byteLength < bytes.byteLength) await Bun.write(`${path}.gz`, g)
    before += bytes.byteLength
    after += Math.min(b.byteLength, bytes.byteLength)
    count++
  }),
)
const mb = (n: number) => (n / 1048576).toFixed(1)
console.log(
  `precompressed ${count} files: ${mb(before)} MB, ${mb(after)} MB as brotli`,
)

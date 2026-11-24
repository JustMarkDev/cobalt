type Token =
  | { t: 'char'; c: string }
  | { t: 'one' }
  | { t: 'star' }
  | { t: 'any' }
  | { t: 'dirs' }

function tokens(glob: string): Array<Token> {
  const out: Array<Token> = []
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out.push({ t: 'dirs' })
        i += 2
      } else {
        out.push({ t: 'any' })
        i += 1
      }
    } else if (ch === '*') out.push({ t: 'star' })
    else if (ch === '?') out.push({ t: 'one' })
    else out.push({ t: 'char', c: ch })
  }
  return out
}

export type GlobMatcher = { test: (path: string) => boolean }

export function globMatcher(glob: string): GlobMatcher {
  const toks = tokens(glob)
  const m = toks.length
  const size = 2 * m + 1
  const inside = (k: number) => m + 1 + k

  const close = (set: Uint8Array, s: number) => {
    while (!set[s]) {
      set[s] = 1
      if (s >= m) return
      const tok = toks[s]
      if (tok.t === 'star' || tok.t === 'any' || tok.t === 'dirs') s += 1
      else return
    }
  }

  return {
    test(path: string) {
      let cur = new Uint8Array(size)
      close(cur, 0)
      for (const c of path) {
        const next = new Uint8Array(size)
        for (let s = 0; s < size; s++) {
          if (!cur[s]) continue
          if (s > m) {
            const k = s - m - 1
            next[s] = 1
            if (c === '/') close(next, k + 1)
            continue
          }
          if (s === m) continue
          const tok = toks[s]
          if (tok.t === 'char') {
            if (c === tok.c) close(next, s + 1)
          } else if (tok.t === 'one') {
            if (c !== '/') close(next, s + 1)
          } else if (tok.t === 'star') {
            if (c !== '/') close(next, s)
          } else if (tok.t === 'any') close(next, s)
          else {
            next[inside(s)] = 1
            if (c === '/') close(next, s + 1)
          }
        }
        if (!next.includes(1)) return false
        cur = next
      }
      return cur[m] === 1
    },
  }
}

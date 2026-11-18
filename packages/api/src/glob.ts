// Path globs, as policy rules use them: `**` crosses folders, `**/` is any
// number of leading folders (or none), `*` and `?` stay inside one folder.
//
// Matched by walking every place the glob could be at once, one character of
// the path at a time, so the time is at most the glob's length times the
// path's, whatever either holds. A regular expression would backtrack: a glob
// like `**/**/**/**/**/**/**/**/**/**/z` takes seconds against a deep path,
// and both come from people (a repository's rules, a change's files).

type Token =
  | { t: 'char'; c: string }
  | { t: 'one' } // ?
  | { t: 'star' } // *
  | { t: 'any' } // ** not followed by /
  | { t: 'dirs' } // ** followed by /

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
  // State k: about to match token k (k === m: done). State m + 1 + k: inside
  // the `**` then `/` at token k, which may end only after a `/`.
  const size = 2 * m + 1
  const inside = (k: number) => m + 1 + k

  /** Adds a state and every state reachable from it without a character. */
  const close = (set: Uint8Array, s: number) => {
    while (!set[s]) {
      set[s] = 1
      if (s >= m) return
      const tok = toks[s]
      // These match nothing as well as something.
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
            // Inside it: anything, and a `/` may end it.
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

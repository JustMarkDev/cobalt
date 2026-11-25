import { ProviderError } from './types'
import type { Etag, Fetch, ProviderId } from './types'

/** The next page's URL from a `Link` header (GitHub, GitLab and Forgejo all send one). */
export function nextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (m) return m[1]
  }
  return null
}

export type Answer<T> = {
  body: T
  next: string | null
  etag: Etag
  notModified: boolean
}

/**
 * One JSON request to a provider. A 304 answers `notModified` with no body;
 * anything else that is not a success becomes a `ProviderError`.
 */
export async function call<T>(
  provider: ProviderId,
  f: Fetch,
  url: string,
  o: {
    headers: Record<string, string>
    method?: string
    body?: unknown
    etag?: Etag
  },
): Promise<Answer<T>> {
  const res = await f(url, {
    method: o.method ?? 'GET',
    headers: {
      ...o.headers,
      ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(o.etag ? { 'if-none-match': o.etag } : {}),
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  })
  if (res.status === 304)
    return {
      body: undefined as T,
      next: null,
      etag: o.etag ?? null,
      notModified: true,
    }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = text.slice(0, 300)
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: unknown }
      const said = j.message ?? j.error
      if (typeof said === 'string') message = said
    } catch {}
    throw new ProviderError(
      provider,
      res.status,
      `${provider} answered ${res.status}${message ? `: ${message}` : ''}`,
    )
  }
  const text = await res.text()
  return {
    body: (text ? JSON.parse(text) : null) as T,
    next: nextLink(res.headers.get('link')),
    etag: res.headers.get('etag'),
    notModified: false,
  }
}

export const toMs = (iso: string | null | undefined) =>
  iso ? Date.parse(iso) : null

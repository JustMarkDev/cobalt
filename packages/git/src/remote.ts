import { createToken } from '@pierre/sdk/auth'
import { pierreFromEnv } from './pierre'
import type { Pierre } from '@pierre/sdk'

/** How to reach the git data of one repository for one request. */
export type GitRemote = {
  /** `https://<host>/<store>.git`, with no credentials in it. */
  url: string
  /** The `Authorization` header that Code Storage wants. */
  authorization: string
}

export interface GitRemotes {
  open: (
    storeId: string,
    o: {
      write: boolean
      /** Whom the request is for, as Code Storage shows it in its logs. */
      subject: string
      /** The branch no push may rewrite. */
      protect?: string
    },
  ) => Promise<GitRemote>
}

/** Tokens live five minutes: they only need to be valid when the request starts. */
const TTL = 300

export function codeStorageRemotes(
  pierre: () => Pierre = () => pierreFromEnv(),
): GitRemotes {
  return {
    async open(storeId, o) {
      const client = pierre()
      const host = client.options.gitHost
      if (!host) throw new Error('Code Storage has no git host configured.')
      const token = await createToken(client, {
        scopes: o.write ? ['git:read', 'git:write'] : ['git:read'],
        repo: storeId,
        ttl: TTL,
        subject: o.subject,
        ...(o.write && o.protect
          ? {
              ref_policies: [{ pattern: o.protect, ops: ['no-force-push'] }],
            }
          : {}),
      })
      return {
        url: `https://${host}/${storeId}.git`,
        authorization: `Basic ${btoa(`t:${token}`)}`,
      }
    },
  }
}

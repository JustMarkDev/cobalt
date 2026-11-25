import { createToken } from '@pierre/sdk/auth'
import { pierreFromEnv } from './pierre'
import type { Pierre } from '@pierre/sdk'

export type GitRemote = {
  url: string
  authorization: string
}

export interface GitRemotes {
  open: (
    storeId: string,
    o: {
      write: boolean
      subject: string
      protect?: string
    },
  ) => Promise<GitRemote>
}

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

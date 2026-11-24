import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { authClient } from './client'
import type { Account as ApiAccount } from '@cobaltforge/sdk'
import { useOpMaybe } from '~/lib/forge'

export type Role = 'owner' | 'admin' | 'member'
export type AccountKind = 'person' | 'organization'

export type Account = {
  id: string
  kind: AccountKind
  handle: string
  name: string
  description: string
  role: Role | null
}

export type Person = { handle: string; name: string }
export type Invite = { id: string; email: string; role: Role }

const toAccount = (a: ApiAccount): Account => ({
  id: a.id,
  kind: a.kind,
  handle: a.handle,
  name: a.name,
  description: a.bio,
  role: a.role,
})

export function useMe(): Person | null {
  const { data } = authClient.useSession()
  const handle = data?.user.handle
  const name = data?.user.name
  return React.useMemo(
    () => (handle && name ? { handle, name } : null),
    [handle, name],
  )
}

const KEY = 'cb-acting-as'
const listeners = new Set<() => void>()

function readActing(): Record<string, string | undefined> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<
      string,
      string | undefined
    >
  } catch {
    return {}
  }
}

let acting: Record<string, string | undefined> | undefined
const snapshot = () => (acting ??= readActing())
const onServer = {}
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function switchAccount(me: Person, handle: string) {
  acting = { ...snapshot(), [me.handle]: handle }
  try {
    localStorage.setItem(KEY, JSON.stringify(acting))
  } catch {}
  listeners.forEach((l) => l())
}

type Accounts = {
  me: Person | null
  accounts: Array<Account>
  active: Account | null
}

export function useAccounts(): Accounts {
  const me = useMe()
  const listed = useOpMaybe('accounts.list', {}, me !== null)
  const picked = React.useSyncExternalStore(
    subscribe,
    snapshot,
    () => onServer as Record<string, string | undefined>,
  )
  return React.useMemo(() => {
    if (!me) return { me: null, accounts: [], active: null }
    const mine: Account = {
      id: me.handle,
      kind: 'person',
      handle: me.handle,
      name: me.name,
      description: '',
      role: 'owner',
    }
    const all = listed?.data.map(toAccount) ?? []
    const self = all.find((a) => a.handle === me.handle) ?? mine
    const accounts = [self, ...all.filter((a) => a.handle !== me.handle)]
    return {
      me,
      accounts,
      active: accounts.find((a) => a.handle === picked[me.handle]) ?? self,
    }
  }, [me, listed, picked])
}

export function useAccount(handle: string): Account | null | undefined {
  const found = useOpMaybe('accounts.get', { handle }, handle !== '')
  return React.useMemo(() => found && toAccount(found), [found])
}

export const manages = (account: Account | null | undefined) =>
  account?.role === 'owner' || account?.role === 'admin'

export function useOrganization(handle: string) {
  const org = useAccount(handle)
  const isOrg = org?.kind === 'organization'
  const members = useOpMaybe('members.list', { handle }, isOrg)
  const canInvite = isOrg && manages(org)
  const invites = useOpMaybe('invitations.list', { handle }, canInvite)
  return React.useMemo(() => {
    if (org === undefined || (isOrg && members === undefined)) return undefined
    if (!org || !isOrg) return null
    const people = members?.data ?? []
    return {
      org,
      role: org.role,
      members: people.map((m) => ({
        person: { handle: m.handle, name: m.name },
        role: m.role,
      })),
      invites: (invites?.data ?? []).map((i): Invite => ({
        id: i.id,
        email: i.email,
        role: i.role,
      })),
      owners: people.filter((m) => m.role === 'owner').length,
    }
  }, [org, isOrg, members, invites])
}

export function SessionSync() {
  const { data, isPending } = authClient.useSession()
  const queries = useQueryClient()
  const handle = data?.user.handle ?? null
  const seen = React.useRef<string | null | undefined>(undefined)
  React.useEffect(() => {
    if (isPending) return
    if (seen.current !== undefined && seen.current !== handle)
      void queries.invalidateQueries({ queryKey: ['cb'] })
    seen.current = handle
  }, [handle, isPending, queries])
  return null
}

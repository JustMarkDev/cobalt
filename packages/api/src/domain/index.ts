import { DomainPeople } from './people'
import type { DomainPort } from './port'

export * from './records'
export type { DomainPort } from './port'

export class MemoryDomain extends DomainPeople implements DomainPort {}

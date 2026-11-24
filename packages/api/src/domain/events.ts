import { receiptFor } from '../receipt'
import { contributionRefusal } from '../via'
import { apiError } from '../problem'
import type { EventRecord } from '../events'
import type { Principal } from '../auth'
import type { ActorRec, ChangeRec, RepoRec, ViaRec } from './records'
import { DomainPresent } from './present'

export abstract class DomainEvents extends DomainPresent {
  protected emit(
    repo: RepoRec,
    type: string,
    by: ActorRec,
    subject: { object: string; id: string; number: number | null },
    changes: Array<string>,
    data: Record<string, unknown> | null,
  ): EventRecord {
    repo.updated = this.now()
    repo.rev++
    return this.events.append({
      type,
      repo: `${repo.owner}/${repo.name}`,
      repo_id: repo.id,
      actor: this.actor(by),
      via: this.viaOverride ?? receiptFor(),
      subject,
      changes,
      data,
    })
  }

  protected viaOverride: ViaRec | null = null

  protected asActor(p: Principal): ActorRec {
    return this.actorFor(p.handle)
  }

  protected viaOf(p: Principal): ViaRec {
    return this.viaOverride ?? receiptFor(p)
  }

  protected assertMayContribute(
    repo: RepoRec,
    p: Principal,
    what: 'change' | 'issue',
  ) {
    const no = contributionRefusal(repo, p.handle, this.viaOf(p).model, what)
    if (no) throw apiError(no.code, no.detail)
  }

  protected actorFor(handle: string): ActorRec {
    return this.actors.get(handle) ?? this.seedActor(handle, this.now())
  }

  protected touchChange(repo: RepoRec, c: ChangeRec, mutate: () => void) {
    repo.byUpdated.remove(c)
    mutate()
    c.updated = Math.max(this.now(), c.updated + 1)
    c.version++
    repo.byUpdated.add(c)
    if (c.state === 'open' || c.state === 'draft') {
      if (!repo.openChangeByBranch.has(c.branch))
        repo.openChangeByBranch.set(c.branch, c)
    } else if (repo.openChangeByBranch.get(c.branch) === c)
      repo.openChangeByBranch.delete(c.branch)
  }

  protected changeEvent(
    repo: RepoRec,
    c: ChangeRec,
    type: string,
    by: ActorRec,
    changes: Array<string>,
    extra?: Record<string, unknown>,
  ) {
    repo.changeRev++
    return this.emit(
      repo,
      type,
      by,
      { object: 'change', id: c.id, number: c.number },
      changes,
      { ...this.presentChange(repo, c, 'event'), ...extra },
    )
  }
}

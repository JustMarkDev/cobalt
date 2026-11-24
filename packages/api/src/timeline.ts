// The entries of a change's timeline that come from the change itself.
// Pure, so the memory domain and `convex/` list the same entries; each store
// adds the state changes it records and sorts.
import type { z } from 'zod'
import type * as S from './schemas'
import {
  headOf,
  presentActor,
  presentCheck,
  presentEvidence,
  presentFinding,
  presentPatchSet,
  presentReview,
  presentReviewComment,
} from './change-view'
import { presentGuide } from './guides'
import { iso } from './domain/records'
import type {
  ActorRec,
  CheckRec,
  FindingRec,
  GuideRec,
  PatchSetRec,
  ReviewCommentRec,
  ReviewRec,
  ViaRec,
} from './domain/records'

export type TimelineEntry = z.infer<typeof S.TimelineEntry>

export const timelineEntry = (
  kind: TimelineEntry['kind'],
  id: string,
  at: number,
  actor: ActorRec | null,
  via: ViaRec | null,
  summary: string,
  item: unknown,
): TimelineEntry => ({
  object: 'timeline_entry',
  id: `${kind}:${id}`,
  kind,
  created_at: iso(at),
  actor: actor ? presentActor(actor) : null,
  via,
  summary,
  item: item as TimelineEntry['item'],
})

type Evidence = {
  id: string
  kind: 'image' | 'recording' | 'preview' | 'test_results'
  caption: string
  by: ActorRec
  created: number
}
type Upload = {
  id: string
  contentType: string
  size: number
  sha256?: string | null
}

export function changeEntries<E extends Evidence>(
  c: {
    id: string
    number: number
    patchSets: Array<PatchSetRec>
    comments?: Array<ReviewCommentRec>
    reviews: Array<ReviewRec>
    findings: Array<FindingRec>
    checks: Array<CheckRec>
    guide?: GuideRec
    evidence?: ReadonlyArray<E>
  },
  a: {
    repoUrl: string
    apiUrl: string
    /** Who a finding's label belongs to. */
    findingActor: (by: string) => ActorRec | null
    /** The upload behind a piece of evidence; null leaves it out. */
    upload: (e: E) => Upload | null
  },
): Array<TimelineEntry> {
  const out: Array<TimelineEntry> = []
  for (const ps of c.patchSets)
    out.push(
      timelineEntry(
        'patch_set',
        String(ps.n),
        ps.created,
        ps.author,
        ps.via ?? null,
        `Patch set ${ps.n}: ${ps.note}`,
        presentPatchSet(a.repoUrl, c, ps),
      ),
    )
  for (const x of c.comments ?? [])
    out.push(
      timelineEntry(
        'comment',
        x.id,
        x.created,
        x.author,
        x.via ?? null,
        `${x.file ? `${x.file}${x.line ? `:${x.line}` : ''}: ` : ''}${x.body.split('\n')[0]}`,
        presentReviewComment(c, x),
      ),
    )
  for (const r of c.reviews)
    out.push(
      timelineEntry(
        'review',
        r.id,
        r.created,
        r.actor,
        r.via ?? null,
        `${r.state === 'changes' ? 'asked for changes' : r.state} on patch set ${r.patchSet}${r.carries ? '' : ' (stale)'}`,
        presentReview(r),
      ),
    )
  for (const f of c.findings)
    out.push(
      timelineEntry(
        'finding',
        f.id,
        f.created,
        a.findingActor(f.by),
        f.via ?? null,
        `${f.label} (${f.severity}): ${f.title}`,
        presentFinding(a.repoUrl, c, f),
      ),
    )
  for (const k of c.checks)
    out.push(
      timelineEntry(
        'check',
        k.id,
        k.updated,
        null,
        null,
        `${k.name}: ${k.state}`,
        presentCheck(k),
      ),
    )
  if (c.guide)
    out.push(
      timelineEntry(
        'guide',
        `${c.id}:${c.guide.created}`,
        c.guide.created,
        c.guide.by,
        c.guide.via ?? null,
        `Guide for patch set ${c.guide.patchSet}: ${c.guide.summary.split('\n')[0]}`,
        presentGuide(c.number, headOf(c).n, c.guide, presentActor, iso),
      ),
    )
  for (const e of c.evidence ?? []) {
    const u = a.upload(e)
    if (u)
      out.push(
        timelineEntry(
          'evidence',
          e.id,
          e.created,
          e.by,
          null,
          `${e.kind}: ${e.caption}`,
          presentEvidence(a.apiUrl, c, e, u),
        ),
      )
  }
  return out
}

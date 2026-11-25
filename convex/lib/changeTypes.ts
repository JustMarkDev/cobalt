import type {
  ActorRec,
  CheckRec,
  FindingRec,
  GuideRec,
  PatchSetRec,
  ReviewCommentRec,
  ReviewRec,
} from '@cobaltforge/api/domain/records'
import type { ChangeState } from '@cobaltforge/api/lifecycles'

export type {
  ActorRec,
  Assume,
  CheckRec,
  CustomRuleRec,
  FileStat,
  FindingRec,
  GuideRec,
  PatchSetRec,
  PolicyExceptionRec,
  ReviewCommentRec,
  ReviewRec,
  RuleMode,
  SuggestionRec,
  TestCaseRec,
  ViaRec,
} from '@cobaltforge/api/domain/records'
export type { ChangeState } from '@cobaltforge/api/lifecycles'

export type UploadSummary = {
  id: string
  contentType: string
  size: number
  sha256: string
}
export type EvidenceRec = {
  id: string
  kind: 'image' | 'recording' | 'preview' | 'test_results'
  caption: string
  uploadId: string
  upload?: UploadSummary
  by: ActorRec
  created: number
}
export type ChangeRec = {
  id: string
  number: number
  title: string
  description: string
  state: ChangeState
  abandonedFrom?: 'draft' | 'open'
  author: ActorRec
  base: string
  branch: string
  patchSets: Array<PatchSetRec>
  reviews: Array<ReviewRec>
  findings: Array<FindingRec>
  checks: Array<CheckRec>
  stackId: string | null
  labels: Array<string>
  mirrors: Array<{ host: string; number: number; origin: 'here' | 'there' }>
  evidence?: Array<EvidenceRec>
  comments?: Array<ReviewCommentRec>
  guide?: GuideRec
  commentRev?: number
  baseFiles?: Record<string, string | null>
  created: number
  updated: number
  landed: number | null
  version: number
}
export type Requirement = {
  id: string
  rule: string
  state: 'pass' | 'fail' | 'pending' | 'na'
  detail: string
  needs: Record<string, unknown> | null
  blocking: Array<string>
}

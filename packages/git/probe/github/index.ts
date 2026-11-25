import { create } from './01-create'
import { pull } from './02-pull'
import { push } from './03-push'
import { divergence } from './04-divergence'
import { force } from './05-force'
import { deletion } from './06-delete'
import { protection } from './07-protection'
import { rename } from './08-rename'
import { large } from './09-large'
import { closedPr } from './10-closed-pr'
import { lfs } from './11-lfs'
import type { Scenario } from '../lib'

export const githubScenarios: Array<Scenario> = [
  create,
  pull,
  push,
  divergence,
  force,
  deletion,
  protection,
  rename,
  large,
  closedPr,
  lfs,
]

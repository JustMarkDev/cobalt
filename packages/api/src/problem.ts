import { Data } from 'effect'

export const errorCatalog = {
  invalid_request: {
    status: 400,
    title: 'The request is not valid',
    retryable: false,
    exit: 2,
    hint: 'Fix the fields listed in errors[] and send it again.',
  },
  cursor_mismatch: {
    status: 400,
    title: 'The cursor does not belong to this request',
    retryable: false,
    exit: 2,
    hint: 'Start again without a cursor. A cursor only works with the filter and sort that produced it.',
  },
  unsupported_version: {
    status: 400,
    title: 'That API version is not supported',
    retryable: false,
    exit: 2,
    hint: 'Omit Cb-Version, or use one listed in GET /v1.',
  },
  unauthenticated: {
    status: 401,
    title: 'Sign in required',
    retryable: false,
    exit: 4,
    hint: 'Send Authorization: Bearer <token>. Create a token in Settings, Agents and tokens.',
  },
  token_invalid: {
    status: 401,
    title: 'The token is not valid',
    retryable: false,
    exit: 4,
    hint: 'Check the token was copied whole. Tokens start with cbp_ or cbo_.',
  },
  token_expired: {
    status: 401,
    title: 'The token has expired',
    retryable: false,
    exit: 4,
    hint: 'Create a new token. Tokens always expire.',
  },
  insufficient_scope: {
    status: 403,
    title: 'The token lacks a scope this needs',
    retryable: false,
    exit: 5,
    hint: 'Create a token with the scopes in required_scopes, or sign in again with them (cb auth login --scope).',
  },
  forbidden: {
    status: 403,
    title: 'You may not do this',
    retryable: false,
    exit: 5,
    hint: 'You can see this, but your role here does not allow the action.',
  },
  token_revoked: {
    status: 401,
    title: 'The token was revoked',
    retryable: false,
    exit: 4,
    hint: 'Create a new token, or sign in again. A revoked token never works again.',
  },
  signature_invalid: {
    status: 403,
    title: 'The signed link is not valid',
    retryable: false,
    exit: 5,
    hint: 'Ask for a new upload link. They expire after an hour and work for one file.',
  },
  confirmation_required: {
    status: 403,
    title: 'Production values need you to confirm first',
    retryable: false,
    exit: 6,
    hint: 'Open confirm_url on a device where you are signed in, confirm, then retry. A confirmation covers this one login for a while.',
  },
  link_required: {
    status: 403,
    title: 'Link your GitHub account first',
    retryable: false,
    exit: 6,
    hint: 'This repository is mirrored to GitHub and its owners turned off writing through the cobalt app, so what you write there must appear under your own GitHub account. Link GitHub in Settings, Accounts, then retry.',
  },
  session_required: {
    status: 403,
    title: 'Confirm this from a signed-in page',
    retryable: false,
    exit: 6,
    hint: 'A token cannot confirm production access, not even its own. Open the page in a browser where you are signed in.',
  },
  secrets_unavailable: {
    status: 503,
    title: 'This server keeps no secret values',
    retryable: false,
    exit: 1,
    hint: 'The server has no CB_SECRETS_KEY, so it seals and opens nothing. Names and kinds still work.',
  },
  model_declined: {
    status: 403,
    title: 'This repository takes no changes from that model',
    retryable: false,
    exit: 5,
    hint: 'The tool declared a model the repository declines (declined_models). Use another model, or ask an owner.',
  },
  denounced: {
    status: 403,
    title: 'This account may not contribute here',
    retryable: false,
    exit: 5,
    hint: 'The owners denounced this account. The reason is in detail.',
  },
  limit_reached: {
    status: 409,
    title: 'You have reached a limit on how many of these you can have',
    retryable: false,
    exit: 5,
    hint: 'Delete one you no longer need. GET /v1/limits lists the numbers.',
  },
  plan_required: {
    status: 402,
    title: 'This needs a paid plan',
    retryable: false,
    exit: 5,
    hint: 'Upgrade the account that owns it. An organization needs Team or Business for private repositories, and Business for its audit log and policies.',
  },
  read_only: {
    status: 409,
    title: 'This only reads for now',
    retryable: false,
    exit: 5,
    hint: 'The account is on the Free plan with a private repository, or is waiting to be deleted. Clones, fetches and exports still work.',
  },
  upload_incomplete: {
    status: 409,
    title: 'The file has not been uploaded yet',
    retryable: false,
    exit: 2,
    hint: 'PUT the bytes to the upload_url from the upload, then use it.',
  },
  moved: {
    status: 308,
    title: 'This was renamed',
    retryable: false,
    exit: 3,
    hint: 'Follow Location. It keeps the method and body. Store the new address, or better, the id.',
  },
  not_found: {
    status: 404,
    title: 'Not found',
    retryable: false,
    exit: 3,
    hint: 'Check the path. Private things answer 404 to everyone who cannot see them. GET /v1 lists the collections.',
  },
  method_not_allowed: {
    status: 405,
    title: 'That method is not allowed here',
    retryable: false,
    exit: 2,
    hint: 'The Allow header lists the methods this path accepts.',
  },
  invalid_state: {
    status: 409,
    title: 'The thing is not in a state that allows this',
    retryable: false,
    exit: 2,
    hint: 'Read the object and check its actions map.',
  },
  stale_head: {
    status: 409,
    title: 'The change moved since you read it',
    retryable: false,
    exit: 2,
    hint: 'Read the change again, check the new head, and send expected_tree for it.',
  },
  parent_not_landed: {
    status: 409,
    title: 'A change below this one in the stack has not landed',
    retryable: false,
    exit: 5,
    hint: 'Land the stack with POST /v1/repos/{owner}/{repo}/stacks/{stack}/land, or land the parent first.',
  },
  policy_blocked: {
    status: 409,
    title: 'Policy blocked this',
    retryable: false,
    exit: 5,
    hint: 'Stop and report the requirements. Do not work around the policy.',
  },
  request_in_progress: {
    status: 409,
    title: 'A request with this Idempotency-Key is still running',
    retryable: true,
    exit: 1,
    hint: 'Wait for Retry-After and send the same request with the same key.',
  },
  payload_too_large: {
    status: 413,
    title: 'The body is too large',
    retryable: false,
    exit: 2,
    hint: 'Bodies are limited to 1 MiB. Upload large files with POST /v1/uploads.',
  },
  unsupported_media_type: {
    status: 415,
    title: 'Unsupported media type',
    retryable: false,
    exit: 2,
    hint: 'Set Content-Type: application/json.',
  },
  version_mismatch: {
    status: 412,
    title: 'Someone changed this since you read it',
    retryable: false,
    exit: 2,
    hint: 'The current object is in current. Merge your change into it and send If-Match with its ETag.',
  },
  request_outcome_unknown: {
    status: 409,
    title:
      'The first request with this Idempotency-Key changed something, then lost its answer',
    retryable: false,
    exit: 1,
    hint: 'Read the object to see where it stands. Use a new key only for a new request.',
  },
  idempotency_key_reused: {
    status: 422,
    title: 'This Idempotency-Key was used for a different request',
    retryable: false,
    exit: 2,
    hint: 'Use a new key for a new request, or repeat the original request exactly.',
  },
  rate_limited: {
    status: 429,
    title: 'Rate limit reached',
    retryable: true,
    exit: 1,
    hint: 'Wait for Retry-After seconds. RateLimit headers on every response say how much is left.',
  },
  concurrency_limited: {
    status: 429,
    title: 'Too many requests in flight',
    retryable: true,
    exit: 1,
    hint: 'Wait for a running request to finish, or wait for Retry-After.',
  },
  internal: {
    status: 500,
    title: 'Something broke on our side',
    retryable: false,
    exit: 1,
    hint: 'This is a bug. Quote request_id when you report it.',
  },
  backend_unavailable: {
    status: 503,
    title: 'A service we depend on did not answer',
    retryable: true,
    exit: 1,
    hint: 'Retry after Retry-After seconds with backoff. Reads and keyed writes are safe to repeat.',
  },
} as const

export type ErrorCode = keyof typeof errorCatalog

export type FieldError = {
  pointer: string
  code: string
  message: string
}

export class ApiError extends Data.TaggedError('ApiError')<{
  readonly code: ErrorCode
  readonly detail: string
  readonly hint?: string
  readonly errors?: ReadonlyArray<FieldError>
  readonly extra?: Record<string, unknown>
  readonly retryAfter?: number
  readonly headers?: Record<string, string>
  readonly retryable?: boolean
}> {}

export const apiError = (
  code: ErrorCode,
  detail: string,
  more: Omit<ConstructorParameters<typeof ApiError>[0], 'code' | 'detail'> = {},
) => new ApiError({ code, detail, ...more })

export type Problem = {
  type: string
  title: string
  status: number
  code: ErrorCode
  detail: string
  hint: string
  retryable: boolean
  exit_code: number
  request_id: string
  errors?: ReadonlyArray<FieldError>
  [member: string]: unknown
}

export function toProblem(error: ApiError, requestId: string): Problem {
  const entry = errorCatalog[error.code]
  return {
    type: `https://cobaltforge.dev/docs/api/errors#${error.code}`,
    title: entry.title,
    status: entry.status,
    code: error.code,
    detail: error.detail,
    hint: error.hint ?? entry.hint,
    retryable: error.retryable ?? entry.retryable,
    exit_code: entry.exit,
    request_id: requestId,
    ...(error.errors ? { errors: error.errors } : {}),
    ...error.extra,
  }
}

import { bucket, defineRailway, github, project, service } from 'railway/iac'

// The Railway side of source.code: one web service and the bucket that holds
// uploaded files. Variables stay in the Railway dashboard (`managed: false`),
// so secrets never enter this file. Preview a change with `railway config
// plan`, apply it with `railway config apply`.
export default defineRailway(() => {
  // Uploads (`packages/api/src/stores/blobs.ts`). The service reads it through
  // the S3_* variables, which reference this bucket's credentials.
  const blobs = bucket('blobs', { region: 'iad' })

  const web = service('web', {
    // Deploys only a commit whose GitHub checks passed.
    source: github('JustMarkDev/source.code', {
      branch: 'main',
      checkSuites: true,
    }),
    // Railpack runs `bun install --frozen-lockfile` before this.
    build: {
      builder: 'RAILPACK',
      buildEnvironment: 'V3',
      buildCommand: 'bun run --cwd apps/web build',
    },
    start: 'bun run start',
    // Answers without calling Convex, so a slow Convex never fails a deploy.
    healthcheck: '/api/v1',
    deploy: {
      // The old copy keeps serving a little after the new one is healthy, and
      // gets time to finish its requests after SIGTERM (`apps/web/server.ts`).
      overlapSeconds: 10,
      drainingSeconds: 30,
    },
    // Virginia, next to the Convex deployment (AWS us-east-1).
    replicas: { 'us-east4-eqdc4a': 1 },
  })

  return project('source-code', {
    variables: { managed: false },
    resources: [web, blobs],
  })
})

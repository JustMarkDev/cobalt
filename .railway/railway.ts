import { bucket, defineRailway, github, project, service } from 'railway/iac'

export default defineRailway(() => {
  const blobs = bucket('blobs', { region: 'iad' })

  const web = service('web', {
    source: github('JustMarkDev/cobalt', {
      branch: 'main',
      checkSuites: true,
    }),
    build: {
      builder: 'RAILPACK',
      buildEnvironment: 'V3',
      buildCommand: 'bun run build:deploy',
    },
    start: 'bun run start',
    healthcheck: '/api/v1',
    deploy: {
      overlapSeconds: 10,
      drainingSeconds: 30,
    },
    replicas: { 'us-east4-eqdc4a': 1 },
  })

  return project('cobaltforge', {
    variables: { managed: false },
    resources: [web, blobs],
  })
})

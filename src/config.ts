import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

export interface Config {
  readonly jobsTable: string
  readonly recordingsTable: string
  readonly audioBucket: string
  readonly claudeApiKey: string
  readonly awsRegion: string
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export async function loadConfig(): Promise<Config> {
  const awsRegion = process.env['AWS_REGION'] ?? 'eu-west-1'
  const claudeSecretName = requireEnv('CLAUDE_SECRET_NAME')

  // Claude API key fetched from Secrets Manager at cold start — never in env vars or logs (D-038)
  const sm = new SecretsManagerClient({ region: awsRegion })
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: claudeSecretName }))
  const claudeApiKey = secret.SecretString ?? ''
  if (!claudeApiKey) throw new Error('Claude API key secret is empty')

  return {
    jobsTable: requireEnv('JOBS_TABLE_NAME'),
    recordingsTable: requireEnv('RECORDINGS_TABLE_NAME'),
    audioBucket: requireEnv('AUDIO_BUCKET_NAME'),
    claudeApiKey,
    awsRegion,
  }
}

import { execFileSync } from 'node:child_process'
import { E2E_EMAIL, E2E_PASSWORD } from './helpers'

export default async function globalSetup() {
  const base = 'http://localhost:8799'
  const probe = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }) })
  if (probe.status === 200) return // dados já semeados (servidor reutilizado)
  execFileSync('node', ['--experimental-strip-types', 'scripts/seed-demo.ts', base, E2E_EMAIL, E2E_PASSWORD], { stdio: 'inherit' })
}

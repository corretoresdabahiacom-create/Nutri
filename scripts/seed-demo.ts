// Uso: node --experimental-strip-types scripts/seed-demo.ts https://SEU-WORKER.workers.dev demo@exemplo.com 'SenhaForte123'
import { seedDemo } from './demo-data.ts'
const [base, email, password] = process.argv.slice(2)
if (!base || !email || !password) { console.error('Uso: seed-demo.ts <url-base> <email> <senha>'); process.exit(1) }
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base.replace(/\/$/, '') + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, data: await r.json().catch(() => ({})) }
}
const r = await seedDemo(call, { email, password })
console.log('Organização DEMO criada:', r.org_id, '\nLogin:', email)

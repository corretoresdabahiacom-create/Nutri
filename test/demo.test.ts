import { describe, expect, it } from 'vitest'
import { call, get } from './helpers'
import { seedDemo } from '../scripts/demo-data'

describe('dados de demonstração e exportações', () => {
  it('semeia dados fictícios completos e todos os painéis respondem', async () => {
    const r = await seedDemo(async (m, p, t, b) => { const x = await call(m, p, t, b); return { status: x.status, data: x.data } }, { email: 'demo@teste.dev', password: 'Senha-demo-123' })
    for (const p of ['/api/dashboard/sports', '/api/dashboard/hospital', '/api/dashboard/quality', `/api/uan/kpis?unit_id=${r.units.uan}`, `/api/stock/balance?unit_id=${r.units.uan}`]) {
      const x = await get(p, r.token); expect(x.status, p).toBe(200)
    }
    const h = await get('/api/dashboard/hospital', r.token)
    expect(h.data.pending_with_critical_conflict).toBe(1) // paciente alérgico a leite + macarrão com queijo
    const f = await call('GET', '/api/exports/foods.csv', r.token)
    expect(f.status).toBe(200); expect(String(f.data)).toContain('DEMO fictício')
    expect((await call('GET', '/api/exports/inexistente.csv', r.token)).status).toBe(404)
    const au = await get('/api/audit?action=export', r.token)
    expect(JSON.stringify(au.data)).toContain('export')
  })
})

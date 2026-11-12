import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { get, newOrg, post, unit, userWithRole } from './helpers'

describe('tendências', () => {
  it('agrega séries por dia, respeita unidade/organização e não inventa dias sem registro', async () => {
    const a = await newOrg(), b = await newOrg(); const u = await unit(a.token, 'UAN', 'uan'); const ub = await unit(b.token, 'UAN B', 'uan')
    const today = new Date().toISOString().slice(0, 10), ts = new Date().toISOString()
    for (const [id, org, un, q] of [['w1', a.orgId, u, 500], ['w2', a.orgId, u, 250], ['w3', b.orgId, ub, 9999]] as const)
      await env.DB.prepare("INSERT INTO waste_records (id,org_id,unit_id,date,kind,qty_g,created_at,updated_at) VALUES (?,?,?,?,'desperdicio',?,?,?)").bind(id, org, un, today, q, ts, ts).run()
    const r = await get(`/api/trends/waste_g?days=30&unit_id=${u}`, a.token)
    expect(r.status).toBe(200); expect(r.data.points).toEqual([{ date: today, value: 750 }])
    expect((await get(`/api/trends/waste_g?days=30`, a.token)).data.points[0].value).toBe(750) // sem vazar a outra organização
    expect((await get(`/api/trends/waste_g?unit_id=${ub}`, a.token)).status).toBe(404) // unidade de outra organização
    expect((await get('/api/trends/xyz', a.token)).status).toBe(404)
    expect((await get('/api/trends', a.token)).data.items.map((m: any) => m.key)).toContain('production_cost_per_portion')
    const cook = await userWithRole(a.token, 'cozinheiro', u)
    expect((await get('/api/trends/revenue', cook.token)).status).toBe(404)
  })
})

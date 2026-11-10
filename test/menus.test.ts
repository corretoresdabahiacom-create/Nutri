import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { get, newOrg, post, put, del, call, unit, userWithRole } from './helpers'
import { runDueJobs } from '../src/worker/lib/jobs'

async function food(t: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/foods', t, { name, source: 'DEMO fictício', energy_kcal: 100, protein_g: 5, carb_g: 20, fat_g: 2, fiber_g: 1, sodium_mg: 100, ...extra })
  expect(r.status).toBe(201); return r.data.id as string
}
async function recipe(t: string, name: string, foodId: string, approve = true, extra: Record<string, unknown> = {}) {
  const r = await post('/api/recipes', t, { name, portions: 10, yield_g: 2000, items: [{ food_id: foodId, net_g: 1000, gross_g: 1000 }], ...extra })
  expect(r.status).toBe(201)
  if (approve) expect((await post(`/api/recipes/${r.data.id}/approve`, t, { nutrition_reviewed: true, allergens_reviewed: true })).status).toBe(200)
  return r.data.id as string
}
async function setup(kind = 'restaurant') { const o = await newOrg('enterprise'); return { o, u: await unit(o.token, 'Unidade', kind) } }

describe('cardápios', () => {
  it('fluxo rascunho → aprovação → publicação com link público sem custos; nova versão arquiva a anterior', async () => {
    const { o, u } = await setup()
    const f1 = await food(o.token, 'Arroz'); await post('/api/prices', o.token, { food_id: f1, price_per_kg: 5, source: 'DEMO fictício', valid_from: '2026-01-01' })
    const r1 = await recipe(o.token, 'Prato A', f1)
    const m = await post('/api/menus', o.token, { name: 'Semana 1', unit_id: u, items: [{ recipe_id: r1, date: '2026-07-01', meal_type: 'almoco', planned_portions: 20 }] })
    expect(m.status).toBe(201)
    expect(m.data.total_cost).toBe(10) // 0,5kg/porção×… 1kg=5 → 0.5/porção × 20
    expect((await post(`/api/menus/${m.data.id}/publish`, o.token)).status).toBe(409)
    expect((await post(`/api/menus/${m.data.id}/approve`, o.token)).status).toBe(200)
    expect((await put(`/api/menus/${m.data.id}`, o.token, { name: 'x' })).status).toBe(409)
    const pub = await post(`/api/menus/${m.data.id}/publish`, o.token)
    expect(pub.data.status).toBe('published')
    const pubGet = await call('GET', pub.data.public_path)
    expect(pubGet.status).toBe(200)
    expect(pubGet.data.items[0].recipe).toBe('Prato A')
    expect(JSON.stringify(pubGet.data)).not.toContain('cost')
    expect((await call('GET', '/api/public/menus/token-invalido')).status).toBe(404)
    const rev = await post(`/api/menus/${m.data.id}/revise`, o.token)
    expect(rev.data.version).toBe(2); expect(rev.data.status).toBe('draft')
    await post(`/api/menus/${rev.data.id}/approve`, o.token)
    await post(`/api/menus/${rev.data.id}/publish`, o.token)
    expect((await call('GET', pub.data.public_path)).status).toBe(404) // versão anterior arquivada
    expect((await get(`/api/menus/${m.data.id}`, o.token)).data.status).toBe('archived')
  })
  it('bloqueia aprovação com ingrediente/tag excluída ou ficha não aprovada', async () => {
    const { o, u } = await setup()
    const leite = await food(o.token, 'Leite demo', { tags: ['lactose'] })
    const arroz = await food(o.token, 'Arroz')
    const rBad = await recipe(o.token, 'Pudim', leite), rDraft = await recipe(o.token, 'Rascunho', arroz, false)
    const m = await post('/api/menus', o.token, { name: 'Sem lactose', unit_id: u, excluded_tags: ['lactose'], items: [{ recipe_id: rBad }, { recipe_id: rDraft }] })
    const ap = await post(`/api/menus/${m.data.id}/approve`, o.token)
    expect(ap.status).toBe(409)
    expect(JSON.stringify(ap.data.error.details)).toContain('tag excluída')
    expect(JSON.stringify(ap.data.error.details)).toContain('não aprovada')
  })
  it('separação de permissões: quem edita não aprova/publica; isolamento entre organizações', async () => {
    const { o, u } = await setup(); const b = await newOrg()
    const f1 = await food(o.token, 'A'); const r = await recipe(o.token, 'P', f1)
    const chef = await userWithRole(o.token, 'chef', u)
    const m = await post('/api/menus', chef.token, { name: 'Chef', unit_id: u, items: [{ recipe_id: r }] })
    expect(m.status).toBe(201)
    expect((await post(`/api/menus/${m.data.id}/publish`, chef.token)).status).toBeGreaterThanOrEqual(403)
    expect((await get(`/api/menus/${m.data.id}`, b.token)).status).toBe(404)
    expect((await post('/api/menus', b.token, { name: 'x', unit_id: u })).status).toBe(404)
  })
  it('publicação agendada vira publicada pelo job; validade expira', async () => {
    const { o, u } = await setup()
    const f1 = await food(o.token, 'A'); const r = await recipe(o.token, 'P', f1)
    const m = await post('/api/menus', o.token, { name: 'Agendado', unit_id: u, items: [{ recipe_id: r }] })
    await post(`/api/menus/${m.data.id}/approve`, o.token)
    const future = new Date(Date.now() + 3600_000).toISOString()
    expect((await post(`/api/menus/${m.data.id}/publish`, o.token, { publish_at: future })).data.status).toBe('scheduled')
    expect((await runDueJobs(env as any, new Date())).published).toBe(0)
    expect((await runDueJobs(env as any, new Date(Date.now() + 7200_000))).published).toBe(1)
    expect((await get(`/api/menus/${m.data.id}`, o.token)).data.status).toBe('published')
  })
  it('duplicar com deslocamento de datas e mover item (drag-and-drop)', async () => {
    const { o, u } = await setup()
    const f1 = await food(o.token, 'A'); const r = await recipe(o.token, 'P', f1)
    const m = await post('/api/menus', o.token, { name: 'Base', unit_id: u, date_from: '2026-07-01', items: [{ recipe_id: r, date: '2026-07-01', meal_type: 'almoco' }] })
    const d = await post(`/api/menus/${m.data.id}/duplicate`, o.token, { shift_days: 7 })
    expect(d.data.items[0].date).toBe('2026-07-08'); expect(d.data.date_from).toBe('2026-07-08')
    expect((await post(`/api/menus/${d.data.id}/move-item`, o.token, { item_id: d.data.items[0].id, date: '2026-07-09', meal_type: 'jantar', position: 3 })).status).toBe(200)
    const v = await get(`/api/menus/${d.data.id}`, o.token)
    expect(v.data.items[0].meal_type).toBe('jantar')
  })
})

describe('restaurante', () => {
  it('importa vendas e calcula margem só onde há custo completo', async () => {
    const { o, u } = await setup()
    const f1 = await food(o.token, 'Carne'); await post('/api/prices', o.token, { food_id: f1, price_per_kg: 30, source: 'DEMO fictício', valid_from: '2026-01-01' })
    const f2 = await food(o.token, 'Sem preço')
    const r1 = await recipe(o.token, 'Bife', f1, true, { portions: 10 }), r2 = await recipe(o.token, 'Misterioso', f2)
    const imp = await post('/api/sales/import', o.token, { unit_id: u, rows: [{ date: '2026-07-01', recipe_id: r1, qty: 10, revenue: 500 }, { date: '2026-07-01', recipe_name: 'Misterioso', qty: 5, revenue: 100 }, { date: 'x', recipe_id: r1, qty: 1, revenue: 1 }] })
    expect(imp.status).toBe(400)
    const ok = await post('/api/sales/import', o.token, { unit_id: u, skip_invalid: true, rows: [{ date: '2026-07-01', recipe_id: r1, qty: 10, revenue: 500 }, { date: '2026-07-01', recipe_name: 'Misterioso', qty: 5, revenue: 100 }, { date: 'x', recipe_id: r1, qty: 1, revenue: 1 }] })
    expect(ok.data.imported).toBe(2); expect(ok.data.skipped).toBe(1)
    const m = await get(`/api/restaurant/margins?unit_id=${u}`, o.token)
    const bife = m.data.items.find((i: any) => i.name === 'Bife'), mist = m.data.items.find((i: any) => i.name === 'Misterioso')
    expect(bife.cost).toBe(30); expect(bife.margin).toBe(470); expect(bife.margin_pct).toBe(94)
    expect(mist.cost).toBeNull()
    expect(m.data.totals.revenue_with_cost).toBe(500)
  })
})

describe('hotelaria/resort', () => {
  it('restrição de hóspede exige consentimento, é cifrada e o resumo da cozinha não expõe nomes', async () => {
    const { o, u } = await setup('hotel')
    expect((await post('/api/guest-restrictions', o.token, { unit_id: u, guest_ref: 'Q101', allergies: ['Amendoim'] })).status).toBe(400)
    const g = await post('/api/guest-restrictions', o.token, { unit_id: u, guest_ref: 'Q101-NOME-SECRETO', allergies: ['Amendoim'], consent_given: true, stay_from: '2026-08-01', stay_to: '2026-08-05' })
    expect(g.status, JSON.stringify(g.data)).toBe(201)
    const raw = await env.DB.prepare('SELECT allergies FROM guest_restrictions WHERE id=?').bind(g.data.id).first<any>()
    expect(raw.allergies.startsWith('v1.')).toBe(true)
    const s = await get(`/api/hotel/restrictions-summary?unit_id=${u}&date=2026-08-03`, o.token)
    expect(s.data.allergies.amendoim).toBe(1)
    expect(JSON.stringify(s.data)).not.toContain('NOME-SECRETO')
    expect((await get(`/api/hotel/restrictions-summary?unit_id=${u}&date=2026-09-03`, o.token)).data.guests_with_records).toBe(0)
  })
  it('link do hóspede: uso único, expira e grava com consentimento', async () => {
    const { o, u } = await setup('hotel')
    const l = await post('/api/guest-links', o.token, { unit_id: u, guest_ref: 'H-1', ttl_hours: 24 })
    expect((await call('GET', l.data.path)).status).toBe(200)
    expect((await call('POST', l.data.path, undefined, { allergies: ['Glúten'] })).status).toBe(400)
    expect((await call('POST', l.data.path, undefined, { allergies: ['Glúten'], consent_given: true })).status).toBe(201)
    expect((await call('POST', l.data.path, undefined, { allergies: ['x'], consent_given: true })).status).toBe(404)
    expect((await get(`/api/guest-restrictions?unit_id=${u}`, o.token)).data.items[0].source).toBe('guest')
  })
  it('demanda não inventa: exige adesão informada ou histórico', async () => {
    const { o, u } = await setup('hotel')
    await post('/api/occupancy', o.token, { unit_id: u, date: '2026-08-10', adults: 100, children: 20, rooms_occupied: 60 })
    expect((await get(`/api/hotel/demand?unit_id=${u}&date=2026-08-10&meal_type=cafe`, o.token)).data.sufficient).toBe(false)
    await post('/api/catering-events', o.token, { unit_id: u, name: 'Casamento', date: '2026-08-10', guests: 50, meal_type: 'cafe' })
    const d = await get(`/api/hotel/demand?unit_id=${u}&date=2026-08-10&meal_type=cafe&take_up_pct=80`, o.token)
    expect(d.data.in_house_portions).toBe(96); expect(d.data.total_portions).toBe(146)
  })
})

describe('consolidação', () => {
  it('compara unidades e respeita escopo', async () => {
    const o = await newOrg('enterprise'); const u1 = await unit(o.token, 'Rest 1', 'restaurant'), u2 = await unit(o.token, 'Rest 2', 'restaurant')
    const f1 = await food(o.token, 'A'); const r = await recipe(o.token, 'P', f1)
    await post('/api/sales', o.token, { unit_id: u1, date: '2026-07-01', recipe_id: r, qty: 1, revenue: 100 })
    await post('/api/sales', o.token, { unit_id: u2, date: '2026-07-01', recipe_id: r, qty: 1, revenue: 50 })
    const c = await get('/api/consolidated/costs', o.token)
    expect(c.data.units.length).toBe(2); expect(c.data.total.revenue).toBe(150)
    const gest = await userWithRole(o.token, 'gestor', u1)
    const cg = await get('/api/consolidated/costs', gest.token)
    expect(cg.data.units.map((x: any) => x.unit_id)).toEqual([u1])
  })
})

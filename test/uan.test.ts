import { describe, expect, it } from 'vitest'
import { get, newOrg, post, put, unit, userWithRole } from './helpers'

async function food(t: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/foods', t, { name, source: 'DEMO fictício', energy_kcal: 100, protein_g: 5, carb_g: 20, fat_g: 2, fiber_g: 1, sodium_mg: 100, ...extra })
  expect(r.status).toBe(201); return r.data.id as string
}
async function setup() {
  const o = await newOrg('enterprise'); const u = await unit(o.token, 'UAN Demo', 'uan'); return { o, u }
}
const tomorrow = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
async function entry(t: string, u: string, foodId: string, qty: number, expiry: string | null, lot: string, cost = 10) {
  const r = await post('/api/stock/entries', t, { unit_id: u, food_id: foodId, qty_g: qty, expiry, lot_code: lot, unit_cost_per_kg: cost })
  expect(r.status).toBe(201); return r.data.lot_id as string
}

describe('estoque', () => {
  it('consome por FEFO, ignora lote vencido e recusa saldo insuficiente', async () => {
    const { o, u } = await setup()
    const arroz = await food(o.token, 'Arroz')
    await entry(o.token, u, arroz, 1000, tomorrow(30), 'L-LONGO', 10)
    await entry(o.token, u, arroz, 1000, tomorrow(5), 'L-CURTO', 8)
    await entry(o.token, u, arroz, 5000, tomorrow(-2), 'L-VENCIDO', 1)
    const ex = await post('/api/stock/exits', o.token, { unit_id: u, food_id: arroz, qty_g: 1500 })
    expect(ex.status).toBe(200)
    expect(ex.data.lots.map((l: any) => [l.lot_code, l.qty_g])).toEqual([['L-CURTO', 1000], ['L-LONGO', 500]])
    expect(ex.data.cost).toBe(13) // 1kg*8 + 0.5kg*10
    const bad = await post('/api/stock/exits', o.token, { unit_id: u, food_id: arroz, qty_g: 600 })
    expect(bad.status).toBe(409)
    expect(bad.data.error.details.available_g).toBe(500)
    const bal = await get(`/api/stock/balance?unit_id=${u}`, o.token)
    expect(bal.data.items[0].available_g).toBe(500)
    expect(bal.data.items[0].expired_g).toBe(5000)
    expect(bal.data.alerts.with_expired).toBe(1)
  })
  it('ajuste exige motivo; transferência move lotes; alerta de estoque mínimo', async () => {
    const { o, u } = await setup()
    const u2 = await unit(o.token, 'Cozinha 2', 'cozinha')
    const f1 = await food(o.token, 'Feijão')
    const lot = await entry(o.token, u, f1, 2000, tomorrow(20), 'L1')
    expect((await post('/api/stock/adjustments', o.token, { lot_id: lot, new_qty_g: 1800 })).status).toBe(400)
    expect((await post('/api/stock/adjustments', o.token, { lot_id: lot, new_qty_g: 1800, reason: 'Inventário' })).status).toBe(200)
    expect((await post('/api/stock/transfers', o.token, { from_unit_id: u, to_unit_id: u2, food_id: f1, qty_g: 800 })).status).toBe(200)
    expect((await get(`/api/stock/balance?unit_id=${u2}`, o.token)).data.items[0].available_g).toBe(800)
    expect((await get(`/api/stock/balance?unit_id=${u}`, o.token)).data.items[0].available_g).toBe(1000)
    await post('/api/stock/levels', o.token, { unit_id: u, food_id: f1, min_g: 5000 })
    expect((await get(`/api/stock/balance?unit_id=${u}`, o.token)).data.alerts.below_min).toBe(1)
  })
  it('isola estoque por organização e unidade', async () => {
    const a = await setup(), b = await setup()
    const f1 = await food(a.o.token, 'X')
    await entry(a.o.token, a.u, f1, 100, null, 'L')
    expect((await get(`/api/stock/balance?unit_id=${a.u}`, b.o.token)).status).toBe(404)
    expect((await post('/api/stock/entries', b.o.token, { unit_id: a.u, food_id: f1, qty_g: 5, lot_code: 'Z' })).status).toBeGreaterThanOrEqual(400)
    const u2 = await unit(a.o.token, 'Outra', 'uan')
    const est = await userWithRole(a.o.token, 'estoquista', u2)
    expect((await get(`/api/stock/balance?unit_id=${a.u}`, est.token)).status).toBe(403)
  })
})

describe('compras e produção', () => {
  async function recipeOf(t: string, foodId: string, grossG = 1000) {
    const r = await post('/api/recipes', t, { name: 'Arroz cozido', portions: 10, yield_g: 2000, items: [{ food_id: foodId, net_g: grossG, gross_g: grossG }] })
    await post(`/api/recipes/${r.data.id}/approve`, t, { nutrition_reviewed: true, allergens_reviewed: true })
    return r.data.id as string
  }
  it('ciclo completo: requisição → aprovação → pedido → recebimento → produção → baixa e custo real', async () => {
    const { o, u } = await setup()
    const arroz = await food(o.token, 'Arroz')
    const sup = (await post('/api/suppliers', o.token, { name: 'Fornecedor Demo', source: 'DEMO fictício' })).data.id
    const rec = await recipeOf(o.token, arroz) // 1000 g para 10 porções
    const po = await post('/api/production-orders', o.token, { unit_id: u, date: tomorrow(1), meal_type: 'almoco', recipe_id: rec, planned_portions: 20 })
    expect(po.status).toBe(201)
    expect(po.data.stock_shortfalls[0].needed_g).toBe(2000)
    expect((await post(`/api/production-orders/${po.data.id}/start`, o.token)).status).toBe(409)
    const sug = await post('/api/purchase-requests/suggest', o.token, { unit_id: u, from: tomorrow(1), to: tomorrow(1) })
    expect(sug.data.suggestions[0].suggested_qty_g).toBe(2000)
    const rq = await post('/api/purchase-requests', o.token, { unit_id: u, items: [{ food_id: arroz, qty_g: 2000 }] })
    expect((await post('/api/purchase-orders', o.token, { unit_id: u, supplier_id: sup, request_id: rq.data.id, items: [{ food_id: arroz, qty_g: 2000, price_per_kg: 6 }] })).data.error.code).toBe('request_not_approved')
    expect((await post(`/api/purchase-requests/${rq.data.id}/approve`, o.token, {})).status).toBe(409) // auto-aprovação
    expect((await post(`/api/purchase-requests/${rq.data.id}/approve`, o.token, { allow_self: true })).status).toBe(200)
    const ord = await post('/api/purchase-orders', o.token, { unit_id: u, supplier_id: sup, request_id: rq.data.id, items: [{ food_id: arroz, qty_g: 2000, price_per_kg: 6 }] })
    expect(ord.status).toBe(201)
    const detail = await get(`/api/purchase-orders/${ord.data.id}`, o.token)
    const rcv = await post(`/api/purchase-orders/${ord.data.id}/receive`, o.token, { items: [{ item_id: detail.data.items[0].id, received_qty_g: 2000, lot_code: 'NF-1', expiry: tomorrow(60) }] })
    expect(rcv.data.status).toBe('received')
    const st = await post(`/api/production-orders/${po.data.id}/start`, o.token)
    expect(st.status).toBe(200)
    expect(st.data.actual_cost).toBe(12) // 2 kg × R$6
    expect((await get(`/api/stock/balance?unit_id=${u}`, o.token)).data.items.length).toBe(0)
    expect((await post(`/api/production-orders/${po.data.id}/complete`, o.token, { produced_portions: 19, leftovers_g: 300, waste_g: 100 })).status).toBe(200)
    const k = await get(`/api/uan/kpis?unit_id=${u}`, o.token)
    expect(k.data.actual_cost_per_portion).toBe(0.63)
    expect(k.data.waste_total_g).toBe(400)
    // preço pago virou preço rastreável com fonte
    const prices = await get('/api/prices', o.token)
    expect(prices.data.items.some((p: any) => String(p.source).startsWith('Pedido de compra'))).toBe(true)
  })
  it('recusa produzir receita não aprovada', async () => {
    const { o, u } = await setup()
    const f1 = await food(o.token, 'A')
    const r = await post('/api/recipes', o.token, { name: 'Rascunho', portions: 1, yield_g: 100, items: [{ food_id: f1, net_g: 100 }] })
    expect((await post('/api/production-orders', o.token, { unit_id: u, date: tomorrow(1), meal_type: 'almoco', recipe_id: r.data.id, planned_portions: 5 })).data.error.code).toBe('recipe_not_approved')
  })
})

describe('dimensionamento e previsão', () => {
  it('dimensionamento exige premissas e calcula a partir delas', async () => {
    const { o, u } = await setup()
    expect((await post('/api/uan/dimensioning', o.token, { unit_id: u, portions_per_meal: 500 })).status).toBe(400)
    await post('/api/equipment', o.token, { unit_id: u, name: 'Forno', capacity_portions_per_hour: 200 })
    const r = await post('/api/uan/dimensioning', o.token, { unit_id: u, portions_per_meal: 600, service_minutes: 120, productivity_portions_per_worker_hour: 30, preparation_hours: 4 })
    expect(r.data.workers_needed).toBe(5)
    expect(r.data.portions_per_hour_at_service).toBe(300)
    expect(r.data.equipment[0].units_needed).toBe(2)
  })
  it('previsão estatística recusa histórico insuficiente e calcula a média do mesmo dia da semana', async () => {
    const { o, u } = await setup()
    const target = '2026-06-10' // quarta
    const q = `/api/uan/demand-forecast?unit_id=${u}&meal_type=almoco&date=${target}`
    expect((await get(q, o.token)).data.sufficient).toBe(false)
    for (const [d, s] of [['2026-06-03', 100], ['2026-05-27', 120], ['2026-05-20', 110]] as const) {
      await post('/api/meal-counts', o.token, { unit_id: u, date: d, meal_type: 'almoco', served: s })
    }
    const r = await get(q + '&margin_pct=10', o.token)
    expect(r.data.sufficient).toBe(true)
    expect(r.data.mean).toBe(110)
    expect(r.data.suggested_portions).toBe(121)
  })
})

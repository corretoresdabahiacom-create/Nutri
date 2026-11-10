import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { get, newOrg, post, put, unit, userWithRole } from './helpers'

async function food(t: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/foods', t, { name, source: 'DEMO fictício', energy_kcal: 100, protein_g: 5, carb_g: 20, fat_g: 2, fiber_g: 1, sodium_mg: 100, ...extra })
  expect(r.status).toBe(201); return r.data.id as string
}
async function recipe(t: string, name: string, foodId: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/recipes', t, { name, portions: 2, yield_g: 400, items: [{ food_id: foodId, net_g: 400 }], ...extra })
  expect(r.status).toBe(201)
  expect((await post(`/api/recipes/${r.data.id}/approve`, t, { nutrition_reviewed: true, allergens_reviewed: true })).status).toBe(200)
  return r.data.id as string
}
async function setup() {
  const o = await newOrg('enterprise')
  const u = await unit(o.token, 'Hospital Demo', 'hospital')
  const bed = (await post('/api/beds', o.token, { unit_id: u, code: 'A-01' })).data.id
  const dt = (await get('/api/diet-types', o.token)).data.items[0]
  return { o, u, bed, dt }
}
async function patient(t: string, u: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/patients', t, { unit_id: u, internal_code: 'P' + Math.random().toString(36).slice(2, 8), name: 'Paciente Demo', status: 'admitted', ...extra })
  expect(r.status).toBe(201); return r.data.id as string
}
async function rx(t: string, pid: string, dt: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/diet-prescriptions', t, { patient_id: pid, diet_type_id: dt, ...extra })
  expect(r.status).toBe(201); return r.data.id as string
}

describe('módulo hospitalar', () => {
  it('cifra campos clínicos do paciente e ocupa o leito', async () => {
    const { o, u, bed } = await setup()
    const pid = await patient(o.token, u, { allergies: ['Camarão'], diagnoses: ['Dx fictício'], bed_id: bed })
    const raw = await env.DB.prepare('SELECT allergies,diagnoses FROM patients WHERE id=?').bind(pid).first<any>()
    expect(raw.allergies.startsWith('v1.')).toBe(true)
    expect(raw.diagnoses).not.toContain('fictício')
    expect((await get(`/api/patients/${pid}`, o.token)).data.allergies).toEqual(['Camarão'])
    const b = await get('/api/beds', o.token)
    expect(b.data.items[0].status).toBe('occupied')
    const p2 = await post('/api/patients', o.token, { unit_id: u, internal_code: 'X2', name: 'Outro', bed_id: bed })
    expect(p2.status).toBe(409)
    await put(`/api/patients/${pid}`, o.token, { status: 'discharged' })
    expect((await get('/api/beds', o.token)).data.items[0].status).toBe('free')
  })
  it('prescrição mantém histórico e exige justificativa na alteração', async () => {
    const { o, u, dt } = await setup()
    const pid = await patient(o.token, u)
    await rx(o.token, pid, dt.id)
    const again = await post('/api/diet-prescriptions', o.token, { patient_id: pid, diet_type_id: dt.id })
    expect(again.status).toBe(400)
    await rx(o.token, pid, dt.id, { change_reason: 'Evolução clínica' })
    const list = await get(`/api/diet-prescriptions?patient_id=${pid}`, o.token)
    expect(list.data.items.map((x: any) => x.status).sort()).toEqual(['active', 'superseded'])
  })
  it('conflito crítico de alergia bloqueia conferência, não há exceção, e a troca de preparação libera o fluxo', async () => {
    const { o, u, dt } = await setup()
    const pid = await patient(o.token, u, { allergies: ['Leite'] })
    await rx(o.token, pid, dt.id)
    const queijo = await food(o.token, 'Queijo demo', { allergens: ['Leite'] })
    const arroz = await food(o.token, 'Arroz demo')
    const rBad = await recipe(o.token, 'Prato com leite', queijo)
    const rOk = await recipe(o.token, 'Arroz simples', arroz)
    const gen = await post('/api/meal-orders/generate', o.token, { unit_id: u, date: '2026-05-01', meals: [{ meal_type: 'almoco', recipe_id: rBad }] })
    expect(gen.data.created).toBe(1)
    expect(gen.data.with_critical_conflicts).toBe(1)
    const ord = (await get('/api/meal-orders?date=2026-05-01', o.token)).data.items[0]
    expect(ord.conflict_level).toBe('critical')
    expect(ord.conflicts[0].code).toBe('allergy')
    const confer = await post(`/api/meal-orders/${ord.id}/confer`, o.token, { ack_note: 'tento forçar' })
    expect(confer.status).toBe(409)
    expect(confer.data.error.code).toBe('critical_conflict')
    expect((await post(`/api/meal-orders/${ord.id}/release`, o.token)).status).toBe(409)
    expect((await put(`/api/meal-orders/${ord.id}`, o.token, { recipe_id: rOk, reason: 'substituição por alergia' })).data.conflict_level).toBe('none')
    expect((await post(`/api/meal-orders/${ord.id}/confer`, o.token)).status).toBe(200)
    const rel = await post(`/api/meal-orders/${ord.id}/release`, o.token)
    expect(rel.status).toBe(200)
    expect(rel.data.label_code).toMatch(/^NV-/)
  })
  it('liberação reavalia: alergia registrada depois da conferência bloqueia a liberação', async () => {
    const { o, u, dt } = await setup()
    const pid = await patient(o.token, u)
    await rx(o.token, pid, dt.id)
    const soja = await food(o.token, 'Soja demo', { allergens: ['Soja'] })
    const r = await recipe(o.token, 'Prato soja', soja)
    await post('/api/meal-orders/generate', o.token, { unit_id: u, date: '2026-05-02', meals: [{ meal_type: 'jantar', recipe_id: r }] })
    const ord = (await get('/api/meal-orders?date=2026-05-02', o.token)).data.items[0]
    expect((await post(`/api/meal-orders/${ord.id}/confer`, o.token)).status).toBe(200)
    await put(`/api/patients/${pid}`, o.token, { allergies: ['soja'] })
    const rel = await post(`/api/meal-orders/${ord.id}/release`, o.token)
    expect(rel.status).toBe(409)
    expect(rel.data.error.code).toBe('critical_conflict')
    expect((await get(`/api/meal-orders/${ord.id}`, o.token)).data.status).toBe('pending')
  })
  it('alertas (intolerância) exigem confirmação registrada; fluxo completo até entrega com permissões separadas', async () => {
    const { o, u, dt } = await setup()
    const pid = await patient(o.token, u, { intolerances: ['Lactose'] })
    await rx(o.token, pid, dt.id)
    const lac = await food(o.token, 'Iogurte demo', { name: 'Iogurte lactose' })
    const r = await recipe(o.token, 'Sobremesa lactose', lac)
    await post('/api/meal-orders/generate', o.token, { unit_id: u, date: '2026-05-03', meals: [{ meal_type: 'ceia', recipe_id: r }] })
    const ord = (await get('/api/meal-orders?date=2026-05-03', o.token)).data.items[0]
    expect(ord.conflict_level).toBe('warning')
    expect((await post(`/api/meal-orders/${ord.id}/confer`, o.token)).data.error.code).toBe('ack_required')
    expect((await post(`/api/meal-orders/${ord.id}/confer`, o.token, { ack_note: 'Paciente aceita, ciente' })).status).toBe(200)
    const cook = await userWithRole(o.token, 'cozinheiro')
    expect((await post(`/api/meal-orders/${ord.id}/release`, cook.token)).status).toBeGreaterThanOrEqual(403)
    expect((await post(`/api/meal-orders/${ord.id}/release`, o.token)).status).toBe(200)
    expect((await post(`/api/meal-orders/${ord.id}/deliver`, cook.token)).status).toBe(409) // precisa produzir antes
    expect((await post(`/api/meal-orders/${ord.id}/produce`, cook.token)).status).toBe(200)
    expect((await post(`/api/meal-orders/${ord.id}/deliver`, cook.token)).status).toBe(200)
    const lab = await get(`/api/meal-orders/${ord.id}/label`, cook.token)
    expect(lab.status).toBe(200)
    const d = await get('/api/dashboard/hospital?date=2026-05-03', o.token)
    expect(d.data.delivered_pct).toBe(100)
    const ev = (await get(`/api/meal-orders/${ord.id}`, o.token)).data.events.map((e: any) => e.action)
    expect(ev).toEqual(['generated', 'conferred', 'released', 'produced', 'delivered'])
  })
  it('cozinha não lê dados clínicos do paciente mas vê alerta de alergia no mapa', async () => {
    const { o, u, dt } = await setup()
    const pid = await patient(o.token, u, { allergies: ['Ovo'], diagnoses: ['Dx secreto'] })
    await rx(o.token, pid, dt.id)
    const cook = await userWithRole(o.token, 'cozinheiro')
    expect((await get(`/api/patients/${pid}`, cook.token)).status).toBeGreaterThanOrEqual(403)
    const arroz = await food(o.token, 'Arroz h')
    const r = await recipe(o.token, 'Arroz h', arroz)
    await post('/api/meal-orders/generate', o.token, { unit_id: u, date: '2026-05-04', meals: [{ meal_type: 'almoco', recipe_id: r }] })
    const map = await get(`/api/hospital/meal-map?unit_id=${u}&date=2026-05-04`, cook.token)
    expect(map.status).toBe(200)
    expect(map.data.meals.almoco[0].allergy_alert).toBe(true)
    expect(JSON.stringify(map.data)).not.toContain('Dx secreto')
  })
  it('isolamento entre organizações e entre unidades', async () => {
    const a = await setup(), b = await setup()
    const pid = await patient(a.o.token, a.u)
    expect((await get(`/api/patients/${pid}`, b.o.token)).status).toBe(404)
    expect((await post('/api/diet-prescriptions', b.o.token, { patient_id: pid, diet_type_id: b.dt.id })).status).toBe(404)
    const u2 = await unit(a.o.token, 'Outro hospital', 'hospital')
    const nut = await userWithRole(a.o.token, 'nutricionista_hospitalar', u2)
    expect((await get(`/api/patients/${pid}`, nut.token)).status).toBe(404)
    expect((await get(`/api/hospital/meal-map?unit_id=${a.u}`, nut.token)).status).toBe(403)
  })
  it('restrição de via de alimentação e disfagia geram conflito crítico', async () => {
    const { o, u, dt } = await setup()
    const pid = await patient(o.token, u, { dysphagia: true })
    await rx(o.token, pid, dt.id, { consistency: 'pastosa' })
    const arroz = await food(o.token, 'Arroz p')
    const r = await recipe(o.token, 'Arroz sólido', arroz)
    await post('/api/meal-orders/generate', o.token, { unit_id: u, date: '2026-05-05', meals: [{ meal_type: 'almoco', recipe_id: r }] })
    const ord = (await get('/api/meal-orders?date=2026-05-05', o.token)).data.items[0]
    expect(ord.conflicts.some((c: any) => c.code === 'consistency' && c.level === 'critical')).toBe(true)
  })
})

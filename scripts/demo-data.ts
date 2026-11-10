/**
 * Dados de demonstração 100% FICTÍCIOS. Os valores nutricionais e preços abaixo são ilustrativos,
 * servem apenas para exercitar a plataforma e NÃO devem ser usados em decisões reais.
 * Todos os registros recebem a fonte "DEMO fictício".
 */
export type Call = (method: string, path: string, token?: string, body?: unknown) => Promise<{ status: number; data: any }>
const SRC = 'DEMO fictício — valores ilustrativos'

export async function seedDemo(call: Call, opts: { email: string; password: string; name?: string }) {
  const ok = async (p: Promise<{ status: number; data: any }>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data }
  const reg = await ok(call('POST', '/api/auth/register', undefined, { email: opts.email, password: opts.password, name: opts.name ?? 'Administrador Demo', organization_name: 'Organização DEMO (fictícia)', plan_key: 'enterprise' }), 'register')
  const t = reg.token as string
  await call('PUT', '/api/org', t, { ai_enabled: true })
  const unit = async (name: string, kind: string) => (await ok(call('POST', '/api/units', t, { name, kind }), 'unit ' + name)).id as string
  const uHosp = await unit('Hospital DEMO', 'hospital'), uUan = await unit('UAN DEMO', 'uan'), uRest = await unit('Restaurante DEMO', 'restaurant'), uHotel = await unit('Hotel DEMO', 'hotel')
  const foods: Record<string, string> = {}
  const F: [string, string, number, number, number, number, number, number, string[], number][] = [
    ['Arroz branco cozido (demo)', 'cereais', 130, 2.5, 28, 0.2, 0.4, 1, [], 6], ['Feijão carioca cozido (demo)', 'leguminosas', 76, 4.8, 13.6, 0.5, 8.5, 2, [], 8],
    ['Peito de frango grelhado (demo)', 'carnes', 160, 31, 0, 3.5, 0, 70, [], 18], ['Brócolis cozido (demo)', 'hortaliças', 35, 2.4, 7, 0.4, 3.3, 41, [], 9],
    ['Queijo minas (demo)', 'laticínios', 260, 17, 3, 20, 0, 400, ['Leite'], 38], ['Macarrão cozido (demo)', 'cereais', 158, 5.8, 31, 0.9, 1.8, 6, ['Glúten'], 7],
    ['Banana prata (demo)', 'frutas', 89, 1.1, 23, 0.3, 2.6, 1, [], 7], ['Aveia em flocos (demo)', 'cereais', 370, 13, 66, 7, 10, 5, ['Glúten'], 14]
  ]
  for (const [name, category, kcal, p, c, f, fiber, na, allergens, price] of F) {
    const id = (await ok(call('POST', '/api/foods', t, { name, category, energy_kcal: kcal, protein_g: p, carb_g: c, fat_g: f, fiber_g: fiber, sodium_mg: na, allergens, source: SRC, table_version: 'demo-1' }), 'food')).id
    foods[name] = id
    await ok(call('POST', '/api/prices', t, { food_id: id, price_per_kg: price, source: SRC, valid_from: '2026-01-01' }), 'price')
  }
  const rec = async (name: string, items: [string, number][], portions: number, tags: string[] = []) => {
    const r = await ok(call('POST', '/api/recipes', t, { name, portions, yield_g: items.reduce((s, i) => s + i[1], 0), items: items.map(([n, g]) => ({ food_id: foods[n], net_g: g, gross_g: g })), diet_tags: tags }), 'recipe ' + name)
    await ok(call('POST', `/api/recipes/${r.id}/approve`, t, { nutrition_reviewed: true, allergens_reviewed: true }), 'approve ' + name)
    return r.id as string
  }
  const rPrato = await rec('Arroz, feijão e frango (demo)', [['Arroz branco cozido (demo)', 1000], ['Feijão carioca cozido (demo)', 800], ['Peito de frango grelhado (demo)', 1000]], 10)
  const rMacarrao = await rec('Macarrão com queijo (demo)', [['Macarrão cozido (demo)', 1200], ['Queijo minas (demo)', 300]], 8)
  const rLegumes = await rec('Brócolis e arroz (demo)', [['Brócolis cozido (demo)', 800], ['Arroz branco cozido (demo)', 800]], 8)
  // esportivo
  const ath = await ok(call('POST', '/api/athletes', t, { unit_id: uUan, name: 'Atleta Demo Fictício', sport: 'corrida', weight_kg: 68, height_cm: 175, allergies: ['Amendoim'], goals: 'Melhorar tempo em 10 km' }), 'athlete')
  await ok(call('POST', '/api/assessments', t, { subject_type: 'athlete', subject_id: ath.id, date: '2026-06-01', weight_kg: 70, body_fat_pct: 16 }), 'assessment')
  await ok(call('POST', '/api/assessments', t, { subject_type: 'athlete', subject_id: ath.id, date: '2026-07-01', weight_kg: 68, body_fat_pct: 14.5 }), 'assessment')
  await ok(call('POST', '/api/substance-rules', t, { name: 'Substância-exemplo-demo', severity: 'warning', source: 'Regra fictícia de demonstração' }), 'rule')
  // hospitalar
  const dts = (await ok(call('GET', '/api/diet-types', t), 'diet-types')).items
  const bed = await ok(call('POST', '/api/beds', t, { unit_id: uHosp, code: 'D-01' }), 'bed')
  const pat = await ok(call('POST', '/api/patients', t, { unit_id: uHosp, internal_code: 'DEMO-001', name: 'Paciente Demo Fictício', bed_id: bed.id, allergies: ['Leite'], status: 'admitted' }), 'patient')
  await ok(call('POST', '/api/diet-prescriptions', t, { patient_id: pat.id, diet_type_id: dts[0].id }), 'rx')
  await ok(call('POST', '/api/meal-orders/generate', t, { unit_id: uHosp, date: new Date().toISOString().slice(0, 10), meals: [{ meal_type: 'almoco', recipe_id: rMacarrao }] }), 'orders')
  // UAN
  await ok(call('POST', '/api/stock/entries', t, { unit_id: uUan, food_id: foods['Arroz branco cozido (demo)'], qty_g: 20000, lot_code: 'DEMO-L1', expiry: '2027-01-01', unit_cost_per_kg: 6 }), 'stock')
  await ok(call('POST', '/api/production-orders', t, { unit_id: uUan, date: new Date().toISOString().slice(0, 10), meal_type: 'almoco', recipe_id: rLegumes, planned_portions: 40 }), 'production')
  // cardápio
  const menu = await ok(call('POST', '/api/menus', t, { name: 'Cardápio DEMO da semana', unit_id: uRest, items: [{ recipe_id: rPrato, date: '2026-07-06', meal_type: 'almoco', planned_portions: 30 }, { recipe_id: rLegumes, date: '2026-07-07', meal_type: 'almoco', planned_portions: 30 }] }), 'menu')
  await ok(call('POST', `/api/menus/${menu.id}/approve`, t), 'menu approve')
  // qualidade
  await ok(call('POST', '/api/temperature-logs', t, { unit_id: uUan, equipment: 'Câmara fria DEMO', reading_c: 3.5, limit_max_c: 5 }), 'temp')
  return { token: t, org_id: reg.organization_id, units: { hospital: uHosp, uan: uUan, restaurant: uRest, hotel: uHotel } }
}

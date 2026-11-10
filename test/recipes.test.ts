import { describe, expect, it } from 'vitest'
import { get, newOrg, post, put, del, userWithRole } from './helpers'

async function food(t: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/foods', t, { name, source: 'DEMO fictício', energy_kcal: 100, protein_g: 10, carb_g: 20, fat_g: 5, fiber_g: 2, sodium_mg: 50, cooking_factor: 1, ...extra })
  expect(r.status).toBe(201)
  return r.data.id as string
}
async function price(t: string, foodId: string, p: number) {
  const r = await post('/api/prices', t, { food_id: foodId, price_per_kg: p, source: 'DEMO fictício', valid_from: '2026-01-01' })
  expect(r.status).toBe(201)
}

describe('alimentos, preços e fichas técnicas', () => {
  it('exige fonte nos alimentos e nos preços (não inventa dados)', async () => {
    const o = await newOrg()
    expect((await post('/api/foods', o.token, { name: 'X' })).status).toBe(400)
    const id = await food(o.token, 'Arroz demo')
    expect((await post('/api/prices', o.token, { food_id: id, price_per_kg: 5, valid_from: '2026-01-01' })).status).toBe(400)
  })
  it('calcula custo total, por porção, por kg, rendimento e composição', async () => {
    const o = await newOrg()
    const a = await food(o.token, 'Ingrediente A', { energy_kcal: 200, protein_g: 20, correction_factor: 1.25, allergens: ['Leite'] })
    const b = await food(o.token, 'Ingrediente B', { energy_kcal: 50, protein_g: 5, tags: ['vegano'] })
    await price(o.token, a, 10) // R$10/kg
    await price(o.token, b, 4)
    const r = await post('/api/recipes', o.token, {
      name: 'Prato teste', portions: 4, yield_g: 800,
      items: [{ food_id: a, net_g: 400, gross_g: 500 }, { food_id: b, net_g: 400 }]
    })
    expect(r.status).toBe(201)
    const c = r.data.calc
    // custo: A 0,5kg*10=5,00 ; B 0,4kg*4=1,60 => 6,60 (B sem gross usa net*FC=1)
    expect(c.total_cost).toBe(6.6)
    expect(c.cost_per_portion).toBe(1.65)
    expect(c.cost_per_kg).toBe(8.25) // 6.6 / 0.8kg
    expect(c.cost_complete).toBe(true)
    // energia: 400g*200/100=800 + 400g*50/100=200 = 1000 ; por porção 250 ; por 100g = 125
    expect(c.nutrition_total.energy_kcal).toBe(1000)
    expect(c.nutrition_per_portion.energy_kcal).toBe(250)
    expect(c.nutrition_per_100g.energy_kcal).toBe(125)
    expect(c.allergens).toEqual(['leite'])
    expect(c.loss_pct).toBe(11.11) // (900-800)/900
  })
  it('sinaliza preços e nutrientes ausentes em vez de inventar', async () => {
    const o = await newOrg()
    const a = await food(o.token, 'Sem preço')
    const n = (await post('/api/foods', o.token, { name: 'Sem nutriente', source: 'DEMO' })).data.id
    const r = await post('/api/recipes', o.token, { name: 'R', portions: 2, items: [{ food_id: a, net_g: 100 }, { food_id: n, net_g: 100 }] })
    expect(r.data.calc.cost_complete).toBe(false)
    expect(r.data.calc.missing_prices.length).toBe(2)
    expect(r.data.calc.nutrition_complete).toBe(false)
    expect(r.data.calc.missing_nutrition).toContain('Sem nutriente')
    expect(r.data.calc.yield_source).toBe('estimado_por_fator_coccao')
  })
  it('aprovação exige revisão; versão aprovada é imutável; nova versão arquiva a anterior', async () => {
    const o = await newOrg()
    const a = await food(o.token, 'Item')
    const r = await post('/api/recipes', o.token, { name: 'Ficha', portions: 1, items: [{ food_id: a, net_g: 100 }] })
    const id = r.data.id
    expect((await post(`/api/recipes/${id}/approve`, o.token, {})).status).toBe(400)
    expect((await post(`/api/recipes/${id}/approve`, o.token, { nutrition_reviewed: true, allergens_reviewed: true })).status).toBe(200)
    const upd = await put(`/api/recipes/${id}`, o.token, { name: 'Alterada' })
    expect(upd.status).toBe(409)
    expect(upd.data.error.code).toBe('approved_immutable')
    expect((await del(`/api/recipes/${id}`, o.token)).status).toBe(409)
    const v2 = await post(`/api/recipes/${id}/versions`, o.token)
    expect(v2.data.version).toBe(2)
    expect((await put(`/api/recipes/${v2.data.id}`, o.token, { name: 'v2 editada' })).status).toBe(200)
    expect((await post(`/api/recipes/${v2.data.id}/approve`, o.token, { nutrition_reviewed: true, allergens_reviewed: true })).status).toBe(200)
    const versions = await get(`/api/recipes/${id}/versions`, o.token)
    expect(versions.data.items.map((x: any) => x.status).sort()).toEqual(['approved', 'archived'])
  })
  it('substitui ingrediente com comparação de custo e preview', async () => {
    const o = await newOrg()
    const a = await food(o.token, 'Caro'), b = await food(o.token, 'Barato')
    await price(o.token, a, 20); await price(o.token, b, 5)
    const r = await post('/api/recipes', o.token, { name: 'Sub', portions: 1, items: [{ food_id: a, net_g: 1000 }] })
    const pv = await post(`/api/recipes/${r.data.id}/substitute`, o.token, { from_food_id: a, to_food_id: b, preview: true })
    expect(pv.data.applied).toBe(false)
    expect(pv.data.cost_per_portion.before).toBe(20)
    expect(pv.data.cost_per_portion.after).toBe(5)
    expect((await get(`/api/recipes/${r.data.id}`, o.token)).data.calc.cost_per_portion).toBe(20)
    await post(`/api/recipes/${r.data.id}/substitute`, o.token, { from_food_id: a, to_food_id: b })
    expect((await get(`/api/recipes/${r.data.id}`, o.token)).data.calc.cost_per_portion).toBe(5)
  })
  it('duplica receita, compara custos e calcula margem', async () => {
    const o = await newOrg()
    const a = await food(o.token, 'I'); await price(o.token, a, 10)
    const r = await post('/api/recipes', o.token, { name: 'Prato', portions: 2, sale_price: 10, items: [{ food_id: a, net_g: 500 }] })
    expect(r.data.calc.cost_per_portion).toBe(2.5)
    expect(r.data.calc.margin_pct).toBe(75)
    const d = await post(`/api/recipes/${r.data.id}/duplicate`, o.token, {})
    expect(d.status).toBe(201)
    const cmp = await get(`/api/recipes/compare?ids=${r.data.id},${d.data.id}`, o.token)
    expect(cmp.data.items.length).toBe(2)
  })
  it('isolamento: receitas e alimentos de outra organização são inacessíveis', async () => {
    const a = await newOrg(), b = await newOrg()
    const fa = await food(a.token, 'Privado A')
    const ra = await post('/api/recipes', a.token, { name: 'Receita A', items: [{ food_id: fa, net_g: 10 }] })
    expect((await get(`/api/recipes/${ra.data.id}`, b.token)).status).toBe(404)
    const bad = await post('/api/recipes', b.token, { name: 'B', items: [{ food_id: fa, net_g: 10 }] })
    expect(bad.status).toBe(400)
    expect((await get(`/api/foods/${fa}`, b.token)).status).toBe(404)
  })
  it('importação de tabela exige origem, versão e confirmação de licença', async () => {
    const o = await newOrg()
    const csv = 'name,energy_kcal,protein_g\nTeste importado,100,5\n'
    expect((await post('/api/foods/import', o.token, { csv })).status).toBe(400)
    expect((await post('/api/foods/import', o.token, { csv, source: 'Tabela X', table_version: '1' })).status).toBe(400)
    const ok = await post('/api/foods/import', o.token, { csv, source: 'Tabela X', table_version: '1', license_confirmed: true })
    expect(ok.data.imported).toBe(1)
    const l = await get('/api/foods?q=importado', o.token)
    expect(l.data.items[0].source).toBe('Tabela X')
    expect(l.data.items[0].table_version).toBe('1')
  })
  it('papel sem permissão não aprova receita', async () => {
    const o = await newOrg()
    const a = await food(o.token, 'I')
    const r = await post('/api/recipes', o.token, { name: 'R', items: [{ food_id: a, net_g: 10 }] })
    const cook = await userWithRole(o.token, 'cozinheiro')
    expect((await post(`/api/recipes/${r.data.id}/approve`, cook.token, { nutrition_reviewed: true, allergens_reviewed: true })).status).toBe(403)
  })
})

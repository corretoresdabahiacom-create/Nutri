import { norm, num, parseJson, round, type Env } from './util'

export const NUTRIENTS = ['energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sodium_mg'] as const
export type Nutrient = (typeof NUTRIENTS)[number]
export type Totals = Record<Nutrient, number>

export interface RecipeCalc {
  recipe_id: string
  items: {
    id: string; food_id: string; food_name: string; net_g: number; gross_g: number; correction_factor: number
    price_per_kg: number | null; cost: number | null; nutrients: Partial<Totals>
  }[]
  gross_total_g: number
  net_total_g: number
  yield_g: number
  yield_source: 'informado' | 'estimado_por_fator_coccao'
  loss_pct: number | null
  portions: number
  portion_g: number | null
  total_cost: number
  cost_complete: boolean
  missing_prices: string[]
  cost_per_portion: number
  cost_per_kg: number | null
  nutrition_total: Totals
  nutrition_per_portion: Totals
  nutrition_per_100g: Totals | null
  nutrition_complete: boolean
  missing_nutrition: string[]
  allergens: string[]
  tags: string[]
  sale_price: number | null
  margin_pct: number | null
}

const zero = (): Totals => ({ energy_kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: 0, sodium_mg: 0 })
const scale = (t: Totals, k: number): Totals => Object.fromEntries(NUTRIENTS.map((n) => [n, round(t[n] * k, 2)])) as Totals

/** Preço vigente mais recente por alimento (somente preços cadastrados com fonte; nunca inventados). */
export const LATEST_PRICE_SQL = `(SELECT p.price_per_kg FROM food_prices p WHERE p.org_id=? AND p.food_id=ri.eff_food_id AND p.valid_from<=date('now')
  ORDER BY p.valid_from DESC, p.created_at DESC LIMIT 1)`

export async function recipeCalc(env: Env, orgId: string, recipeId: string, swap?: { from: string; to: string }): Promise<RecipeCalc | null> {
  const r = await env.DB.prepare('SELECT * FROM recipes WHERE id=? AND org_id=?').bind(recipeId, orgId).first<any>()
  if (!r) return null
  const rows = (await env.DB.prepare(
    `SELECT ri.id,ri.eff_food_id AS food_id,ri.gross_g,ri.net_g,ri.correction_factor AS item_fc,f.name AS food_name,f.correction_factor AS food_fc,f.cooking_factor,
      f.energy_kcal,f.protein_g,f.carb_g,f.fat_g,f.fiber_g,f.sodium_mg,f.allergens,f.tags,${LATEST_PRICE_SQL} AS price_per_kg
     FROM (SELECT x.*, CASE WHEN x.food_id=? THEN ? ELSE x.food_id END AS eff_food_id FROM recipe_items x WHERE x.recipe_id=? AND x.org_id=?) ri
     JOIN foods f ON f.id=ri.eff_food_id`
  ).bind(orgId, swap?.from ?? '', swap?.to ?? '', recipeId, orgId).all<any>()).results
  const total = zero()
  const items: RecipeCalc['items'] = []
  const missingPrices: string[] = [], missingNutr = new Set<string>()
  const allergens = new Set<string>(), tags = new Set<string>()
  let gross = 0, net = 0, estYield = 0, cost = 0
  for (const x of rows) {
    const fc = num(x.item_fc ?? x.food_fc, 1) || 1
    const g = x.gross_g != null ? num(x.gross_g) : num(x.net_g) * fc
    const n = num(x.net_g)
    gross += g; net += n; estYield += n * (num(x.cooking_factor, 1) || 1)
    const nutr: Partial<Totals> = {}
    for (const k of NUTRIENTS) {
      if (x[k] == null) { missingNutr.add(x.food_name); continue }
      nutr[k] = round((num(x[k]) * n) / 100, 3)
      total[k] += (num(x[k]) * n) / 100
    }
    const price = x.price_per_kg == null ? null : num(x.price_per_kg)
    const c = price == null ? null : round((g / 1000) * price, 4)
    if (c == null) missingPrices.push(x.food_name)
    else cost += c
    for (const a of parseJson<string[]>(x.allergens, [])) allergens.add(norm(a))
    for (const t of parseJson<string[]>(x.tags, [])) tags.add(norm(t))
    items.push({ id: x.id, food_id: x.food_id, food_name: x.food_name, net_g: n, gross_g: round(g, 2), correction_factor: fc, price_per_kg: price, cost: c, nutrients: nutr })
  }
  const informed = num(r.yield_g)
  const yieldG = informed > 0 ? informed : round(estYield, 2)
  const portions = num(r.portions, 1) || 1
  const totalCost = round(cost, 4)
  const sale = r.sale_price != null ? num(r.sale_price) : null
  const cpp = totalCost / portions
  return {
    recipe_id: r.id, items,
    gross_total_g: round(gross, 2), net_total_g: round(net, 2), yield_g: yieldG,
    yield_source: informed > 0 ? 'informado' : 'estimado_por_fator_coccao',
    loss_pct: gross > 0 && yieldG > 0 ? round(((gross - yieldG) / gross) * 100, 2) : null,
    portions, portion_g: r.portion_g != null ? num(r.portion_g) : yieldG > 0 ? round(yieldG / portions, 2) : null,
    total_cost: round(totalCost, 2), cost_complete: missingPrices.length === 0 && rows.length > 0, missing_prices: [...new Set(missingPrices)],
    cost_per_portion: round(cpp, 4), cost_per_kg: yieldG > 0 ? round(totalCost / (yieldG / 1000), 2) : null,
    nutrition_total: scale(total, 1), nutrition_per_portion: scale(total, 1 / portions),
    nutrition_per_100g: yieldG > 0 ? scale(total, 100 / yieldG) : null,
    nutrition_complete: missingNutr.size === 0 && rows.length > 0, missing_nutrition: [...missingNutr],
    allergens: [...allergens].sort(), tags: [...tags].sort(), sale_price: sale,
    margin_pct: sale && sale > 0 ? round(((sale - cpp) / sale) * 100, 2) : null
  }
}

/** Escala ingredientes de uma receita para outro número de porções (dimensionamento). */
export function scaleItems(calc: RecipeCalc, targetPortions: number) {
  const k = calc.portions > 0 ? targetPortions / calc.portions : 0
  return calc.items.map((i) => ({ food_id: i.food_id, food_name: i.food_name, gross_g: round(i.gross_g * k, 2), net_g: round(i.net_g * k, 2) }))
}

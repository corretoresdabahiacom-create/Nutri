import { Hono } from 'hono'
import { type AppEnv, audit, can, requireUnit, unitScope } from '../lib/auth'
import { bad, notFound, toCsv } from '../lib/util'

export const exportsRoutes = new Hono<AppEnv>()

/** Exportações CSV de listas operacionais (somente colunas não sensíveis). Cada exportação é auditada. */
const SOURCES: Record<string, { perm: string; unit: boolean; sql: string; cols: string[]; orderBy: string }> = {
  foods: { perm: 'foods.read', unit: false, sql: 'SELECT name,category,energy_kcal,protein_g,carb_g,fat_g,fiber_g,sodium_mg,source,table_version FROM foods WHERE org_id=?', cols: ['name', 'category', 'energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sodium_mg', 'source', 'table_version'], orderBy: 'name' },
  prices: { perm: 'foods.read', unit: false, sql: 'SELECT f.name AS food,p.price_per_kg,p.valid_from,p.source FROM food_prices p JOIN foods f ON f.id=p.food_id WHERE p.org_id=?', cols: ['food', 'price_per_kg', 'valid_from', 'source'], orderBy: 'p.valid_from DESC' },
  recipes: { perm: 'recipes.read', unit: false, sql: 'SELECT name,version,status,portions,yield_g,sale_price FROM recipes WHERE org_id=?', cols: ['name', 'version', 'status', 'portions', 'yield_g', 'sale_price'], orderBy: 'name' },
  production: { perm: 'production.read', unit: true, sql: 'SELECT date,meal_type,planned_portions,produced_portions,status,planned_cost,actual_cost,waste_g,leftovers_g FROM production_orders WHERE org_id=?', cols: ['date', 'meal_type', 'planned_portions', 'produced_portions', 'status', 'planned_cost', 'actual_cost', 'waste_g', 'leftovers_g'], orderBy: 'date DESC' },
  waste: { perm: 'uan.read', unit: true, sql: 'SELECT date,kind,qty_g,cost,reason FROM waste_records WHERE org_id=?', cols: ['date', 'kind', 'qty_g', 'cost', 'reason'], orderBy: 'date DESC' },
  sales: { perm: 'restaurant.read', unit: true, sql: 'SELECT date,recipe_id,qty,revenue,source FROM sales WHERE org_id=?', cols: ['date', 'recipe_id', 'qty', 'revenue', 'source'], orderBy: 'date DESC' },
  stock: { perm: 'stock.read', unit: true, sql: 'SELECT f.name AS food,l.lot_code,l.qty_g,l.expiry,l.unit_cost_per_kg FROM stock_lots l JOIN foods f ON f.id=l.food_id WHERE l.org_id=? AND l.qty_g>0', cols: ['food', 'lot_code', 'qty_g', 'expiry', 'unit_cost_per_kg'], orderBy: 'f.name' },
  temperature: { perm: 'quality.read', unit: true, sql: 'SELECT recorded_at,equipment,reading_c,limit_min_c,limit_max_c,ok FROM temperature_logs WHERE org_id=?', cols: ['recorded_at', 'equipment', 'reading_c', 'limit_min_c', 'limit_max_c', 'ok'], orderBy: 'recorded_at DESC' },
  nonconformities: { perm: 'quality.read', unit: true, sql: 'SELECT created_at,title,severity,status,source,closed_at FROM nonconformities WHERE org_id=?', cols: ['created_at', 'title', 'severity', 'status', 'source', 'closed_at'], orderBy: 'created_at DESC' }
}
exportsRoutes.get('/exports/:entity', async (c) => {
  const name = c.req.param('entity').replace(/\.csv$/, ''), src = SOURCES[name]
  if (!src) throw notFound('Exportação')
  const a = c.get('auth')
  if (!can(a, src.perm) || !can(a, 'reports.export')) throw notFound('Exportação')
  const p: unknown[] = [a.orgId]
  let sql = src.sql
  if (src.unit) {
    const q = new URL(c.req.url).searchParams
    const tbl = sql.includes(' l ') || sql.includes(' l.') ? 'l.' : ''
    if (q.get('unit_id')) { await requireUnit(c, src.perm, q.get('unit_id')); sql += ` AND ${tbl}unit_id=?`; p.push(q.get('unit_id')) }
    else { const s = unitScope(a, src.perm); if (s !== null) { sql += ` AND ${tbl}unit_id IN (${s.map(() => '?').join(',') || "''"})`; p.push(...s) } }
  }
  const rows = (await c.env.DB.prepare(`${sql} ORDER BY ${src.orderBy} LIMIT 20000`).bind(...p).all<Record<string, unknown>>()).results
  await audit(c, 'export', name, undefined, { rows: rows.length, format: 'csv' })
  return new Response('﻿' + toCsv(rows, src.cols), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'no-store' } })
})
export { bad }

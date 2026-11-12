import { Hono } from 'hono'
import { type AppEnv, audit, can, requireUnit, unitScope } from '../lib/auth'
import { bad, notFound, round } from '../lib/util'

export const trends = new Hono<AppEnv>()
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Séries diárias para gráficos. Só agrega dados já registrados; dias sem registro não são preenchidos com zero. */
const METRICS: Record<string, { perm: string; label: string; unit: string; sql: string; dateCol: string }> = {
  production_cost_per_portion: { perm: 'production.read', label: 'Custo real por porção', unit: 'R$', dateCol: 'date',
    sql: "SELECT date d, SUM(actual_cost)/NULLIF(SUM(produced_portions),0) v FROM production_orders WHERE org_id=? AND status='done' AND actual_cost IS NOT NULL" },
  waste_g: { perm: 'uan.read', label: 'Desperdício e sobras', unit: 'g', dateCol: 'date', sql: 'SELECT date d, SUM(qty_g) v FROM waste_records WHERE org_id=?' },
  revenue: { perm: 'restaurant.read', label: 'Receita de vendas', unit: 'R$', dateCol: 'date', sql: 'SELECT date d, SUM(revenue) v FROM sales WHERE org_id=?' },
  meal_conflicts: { perm: 'hospital.read', label: 'Pedidos com conflito crítico', unit: 'pedidos', dateCol: 'date', sql: "SELECT date d, COUNT(*) v FROM meal_orders WHERE org_id=? AND conflict_level='critical'" },
  temperature_out_of_range: { perm: 'quality.read', label: 'Temperaturas fora do limite', unit: 'registros', dateCol: 'substr(recorded_at,1,10)', sql: 'SELECT substr(recorded_at,1,10) d, COUNT(*) v FROM temperature_logs WHERE org_id=? AND ok=0' }
}
trends.get('/trends', async (c) => {
  const a = c.get('auth')
  return c.json({ items: Object.entries(METRICS).filter(([, m]) => can(a, m.perm)).map(([key, m]) => ({ key, label: m.label, unit: m.unit })) })
})
trends.get('/trends/:metric', async (c) => {
  const a = c.get('auth'), m = METRICS[c.req.param('metric')], q = new URL(c.req.url).searchParams
  if (!m || !can(a, m.perm)) throw notFound('Métrica')
  const days = Math.min(Math.max(Number(q.get('days') ?? 30) || 30, 7), 365)
  const to = q.get('to') ?? new Date().toISOString().slice(0, 10)
  if (!DATE.test(to)) throw bad('invalid_field', 'to deve ser AAAA-MM-DD')
  const from = new Date(Date.parse(to) - days * 86400000).toISOString().slice(0, 10)
  const p: unknown[] = [a.orgId]
  let sql = m.sql
  if (q.get('unit_id')) { await requireUnit(c, m.perm, q.get('unit_id')); sql += ' AND unit_id=?'; p.push(q.get('unit_id')) }
  else { const s = unitScope(a, m.perm); if (s !== null) { sql += ` AND unit_id IN (${s.map(() => '?').join(',') || "''"})`; p.push(...s) } }
  sql += ` AND ${m.dateCol}>=? AND ${m.dateCol}<=? GROUP BY d ORDER BY d`
  const rows = (await c.env.DB.prepare(sql).bind(...p, from, to).all<{ d: string; v: number | null }>()).results
  await audit(c, 'read', 'trends', undefined, { metric: c.req.param('metric'), days })
  return c.json({ metric: c.req.param('metric'), label: m.label, unit: m.unit, from, to, points: rows.filter((r) => r.v != null).map((r) => ({ date: r.d, value: round(Number(r.v), 2) })) })
})

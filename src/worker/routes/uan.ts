import { Hono } from 'hono'
import { type AppCtx, type AppEnv, assertCan, audit, can, need, needAny, requireUnit, unitScope } from '../lib/auth'
import { f, mountCrud } from '../lib/crud'
import { recipeCalc, scaleItems } from '../lib/calc'
import { bad, conflict, nowIso, notFound, num, readBody, round, today, uid } from '../lib/util'
import { buildPdf, pdfResponse } from '../lib/pdf'

export const uan = new Hono<AppEnv>()
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MEALS = ['cafe', 'colacao', 'almoco', 'lanche', 'jantar', 'ceia', 'brunch', 'buffet', 'room_service', 'evento'] as const

const std = (table: string, path: string, fields: any[], extra: Record<string, unknown> = {}) =>
  mountCrud(uan, { table, path, read: 'uan.read', write: 'uan.write', unit: 'strict', unitReq: true, filters: ['unit_id'], fields, ...extra })
std('contracts', 'contracts', [f.s('client_name', { req: true, max: 160 }), f.r('meal_price'), f.d('starts_on'), f.d('ends_on'), f.s('notes', { max: 1000 })], { order: 'client_name ASC' })
std('shifts', 'shifts', [f.s('name', { req: true, max: 80 }), f.s('starts', { max: 8 }), f.s('ends', { max: 8 })], { order: 'name ASC' })
std('equipment', 'equipment', [f.s('name', { req: true, max: 120 }), f.r('capacity_portions_per_hour')], { order: 'name ASC' })
std('food_points', 'food-points', [f.s('kind', { req: true, enum: ['refeitorio', 'cozinha', 'buffet', 'bar', 'room_service', 'outlet', 'ponto_alimentacao'] }), f.s('name', { req: true, max: 120 })], { order: 'name ASC' })
std('meal_counts', 'meal-counts', [f.d('date', { req: true }), f.s('meal_type', { req: true, enum: MEALS }), f.s('shift_id', { ref: 'shifts', max: 64 }), f.s('contract_id', { ref: 'contracts', max: 64 }),
  f.r('planned'), f.r('served'), f.r('guests')], { order: 'date DESC' })
std('waste_records', 'waste', [f.d('date', { req: true }), f.s('kind', { enum: ['desperdicio', 'sobra_limpa', 'sobra_suja', 'resto_ingesta', 'vencido'] }), f.s('food_id', { ref: 'foods', max: 64 }),
  f.s('recipe_id', { ref: 'recipes', max: 64 }), f.r('qty_g', { req: true }), f.r('cost'), f.s('reason', { max: 500 })], {
  order: 'date DESC', hooks: { beforeWrite(c: AppCtx, d: any, ex: any) { if (!ex) d.created_by = c.get('auth').userId } }
})
mountCrud(uan, { table: 'stock_levels', path: 'stock/levels', read: 'stock.read', write: 'stock.write', unit: 'strict', unitReq: true, filters: ['unit_id', 'food_id'],
  fields: [f.s('food_id', { req: true, ref: 'foods', max: 64 }), f.r('min_g'), f.r('max_g')] })

// ---------- estoque (lotes, FEFO) ----------
const lotsOf = (c: AppCtx, unitId: string, foodId: string, includeExpired = false) =>
  c.env.DB.prepare(`SELECT * FROM stock_lots WHERE org_id=? AND unit_id=? AND food_id=? AND qty_g>0 ${includeExpired ? '' : "AND (expiry IS NULL OR expiry>=date('now'))"} ORDER BY expiry IS NULL, expiry ASC, received_at ASC`)
    .bind(c.get('auth').orgId, unitId, foodId).all<any>().then((r) => r.results)
async function checkFood(c: AppCtx, id: unknown) {
  if (!(await c.env.DB.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(String(id ?? ''), c.get('auth').orgId).first())) throw bad('invalid_reference', 'Alimento inválido')
}
async function mv(c: AppCtx, unitId: string, foodId: string, lotId: string | null, kind: string, qty: number, cost: number | null, reason?: string | null, refType?: string, refId?: string) {
  await c.env.DB.prepare('INSERT INTO stock_movements (id,org_id,unit_id,food_id,lot_id,kind,qty_g,unit_cost_per_kg,reason,ref_type,ref_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(uid(), c.get('auth').orgId, unitId, foodId, lotId, kind, qty, cost, reason ?? null, refType ?? null, refId ?? null, c.get('auth').userId, nowIso()).run()
}
async function addLot(c: AppCtx, p: { unit_id: string; food_id: string; lot_code: string; qty_g: number; expiry?: string | null; supplier_id?: string | null; cost: number }, kind: string, refType?: string, refId?: string) {
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO stock_lots (id,org_id,unit_id,food_id,lot_code,qty_g,initial_qty_g,expiry,supplier_id,unit_cost_per_kg,received_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, c.get('auth').orgId, p.unit_id, p.food_id, p.lot_code, p.qty_g, p.qty_g, p.expiry ?? null, p.supplier_id ?? null, p.cost, ts, ts, ts).run()
  await mv(c, p.unit_id, p.food_id, id, kind, p.qty_g, p.cost, null, refType, refId)
  return id
}
/** Consome por FEFO. Falha antes de alterar qualquer dado se o saldo (não vencido) for insuficiente. */
async function consume(c: AppCtx, unitId: string, foodId: string, qty: number, kind: string, reason: string | null, refType?: string, refId?: string, dryRun = false) {
  const lots = await lotsOf(c, unitId, foodId)
  const avail = lots.reduce((s, l) => s + l.qty_g, 0)
  if (avail + 1e-9 < qty) return { ok: false as const, available_g: round(avail, 2), cost: 0, taken: [] as any[] }
  let rest = qty, cost = 0
  const taken: any[] = []
  for (const l of lots) {
    if (rest <= 1e-9) break
    const t = Math.min(l.qty_g, rest)
    if (!dryRun) {
      await c.env.DB.prepare('UPDATE stock_lots SET qty_g=qty_g-?, updated_at=? WHERE id=?').bind(t, nowIso(), l.id).run()
      await mv(c, unitId, foodId, l.id, kind, -t, l.unit_cost_per_kg, reason, refType, refId)
    }
    cost += (t / 1000) * l.unit_cost_per_kg
    taken.push({ lot_id: l.id, lot_code: l.lot_code, qty_g: round(t, 2), expiry: l.expiry })
    rest -= t
  }
  return { ok: true as const, available_g: round(avail, 2), cost: round(cost, 2), taken }
}
const needUnit = requireUnit
const positive = (v: unknown, name: string) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw bad('invalid_field', `${name} deve ser > 0`); return n }

uan.post('/stock/entries', need('stock.write'), async (c) => {
  const b = await readBody(c), u = await needUnit(c, 'stock.write', b.unit_id)
  await checkFood(c, b.food_id)
  if (!String(b.lot_code ?? '').trim()) throw bad('missing_field', 'Informe lot_code')
  if (b.expiry && !DATE.test(b.expiry)) throw bad('invalid_field', 'expiry inválida')
  const cost = num(b.unit_cost_per_kg, 0)
  if (cost < 0) throw bad('invalid_field', 'Custo inválido')
  const id = await addLot(c, { unit_id: u, food_id: b.food_id, lot_code: String(b.lot_code), qty_g: positive(b.qty_g, 'qty_g'), expiry: b.expiry ?? null, supplier_id: b.supplier_id ?? null, cost }, 'entry')
  await audit(c, 'create', 'stock_lots', id)
  return c.json({ lot_id: id }, 201)
})
uan.post('/stock/exits', need('stock.write'), async (c) => {
  const b = await readBody(c), u = await needUnit(c, 'stock.write', b.unit_id)
  await checkFood(c, b.food_id)
  const r = await consume(c, u, b.food_id, positive(b.qty_g, 'qty_g'), 'exit', b.reason ? String(b.reason) : null)
  if (!r.ok) throw conflict('insufficient_stock', 'Saldo insuficiente (lotes vencidos não contam)', { available_g: r.available_g })
  await audit(c, 'exit', 'stock_movements', undefined, { food_id: b.food_id, qty_g: b.qty_g })
  return c.json({ ok: true, cost: r.cost, lots: r.taken })
})
uan.post('/stock/adjustments', need('stock.write'), async (c) => {
  const b = await readBody(c)
  const lot = await c.env.DB.prepare('SELECT * FROM stock_lots WHERE id=? AND org_id=?').bind(String(b.lot_id ?? ''), c.get('auth').orgId).first<any>()
  if (!lot) throw notFound('Lote')
  assertCan(c.get('auth'), 'stock.write', lot.unit_id)
  if (!String(b.reason ?? '').trim()) throw bad('missing_field', 'Ajuste exige reason')
  const nq = Number(b.new_qty_g)
  if (!Number.isFinite(nq) || nq < 0) throw bad('invalid_field', 'new_qty_g inválido')
  await c.env.DB.prepare('UPDATE stock_lots SET qty_g=?, updated_at=? WHERE id=?').bind(nq, nowIso(), lot.id).run()
  await mv(c, lot.unit_id, lot.food_id, lot.id, 'adjustment', nq - lot.qty_g, lot.unit_cost_per_kg, String(b.reason))
  await audit(c, 'adjust', 'stock_lots', lot.id, { from: lot.qty_g, to: nq })
  return c.json({ ok: true })
})
uan.post('/stock/transfers', need('stock.write'), async (c) => {
  const b = await readBody(c), from = await needUnit(c, 'stock.write', b.from_unit_id), to = await needUnit(c, 'stock.write', b.to_unit_id)
  if (from === to) throw bad('invalid_field', 'Unidades iguais')
  if (!(await c.env.DB.prepare('SELECT 1 FROM units WHERE id=? AND org_id=?').bind(to, c.get('auth').orgId).first())) throw bad('invalid_reference', 'Unidade de destino inválida')
  await checkFood(c, b.food_id)
  const r = await consume(c, from, b.food_id, positive(b.qty_g, 'qty_g'), 'transfer_out', 'transferência')
  if (!r.ok) throw conflict('insufficient_stock', 'Saldo insuficiente na origem', { available_g: r.available_g })
  for (const t of r.taken) {
    const l = await c.env.DB.prepare('SELECT * FROM stock_lots WHERE id=?').bind(t.lot_id).first<any>()
    await addLot(c, { unit_id: to, food_id: b.food_id, lot_code: l.lot_code, qty_g: t.qty_g, expiry: l.expiry, supplier_id: l.supplier_id, cost: l.unit_cost_per_kg }, 'transfer_in')
  }
  await audit(c, 'transfer', 'stock_movements', undefined, { from, to, food_id: b.food_id, qty_g: b.qty_g })
  return c.json({ ok: true, lots: r.taken })
})
uan.get('/stock/lots', need('stock.read'), async (c) => {
  const q = new URL(c.req.url).searchParams, u = await needUnit(c, 'stock.read', q.get('unit_id'))
  const rows = (await c.env.DB.prepare(`SELECT l.*, f.name AS food_name FROM stock_lots l JOIN foods f ON f.id=l.food_id WHERE l.org_id=? AND l.unit_id=? AND l.qty_g>0 ${q.get('food_id') ? 'AND l.food_id=?' : ''} ORDER BY l.expiry IS NULL, l.expiry`).bind(...[c.get('auth').orgId, u, ...(q.get('food_id') ? [q.get('food_id')] : [])]).all<any>()).results
  return c.json({ items: rows })
})
uan.get('/stock/movements', need('stock.read'), async (c) => {
  const q = new URL(c.req.url).searchParams, u = await needUnit(c, 'stock.read', q.get('unit_id'))
  const rows = (await c.env.DB.prepare('SELECT * FROM stock_movements WHERE org_id=? AND unit_id=? ORDER BY created_at DESC LIMIT 500').bind(c.get('auth').orgId, u).all()).results
  return c.json({ items: rows })
})
async function balance(c: AppCtx, unitId: string, expiringDays = 7) {
  const a = c.get('auth')
  const rows = (await c.env.DB.prepare(`SELECT l.food_id, f.name,
      SUM(CASE WHEN l.expiry IS NULL OR l.expiry>=date('now') THEN l.qty_g ELSE 0 END) AS available_g,
      SUM(CASE WHEN l.expiry<date('now') THEN l.qty_g ELSE 0 END) AS expired_g,
      SUM(CASE WHEN l.expiry>=date('now') AND l.expiry<=date('now', ?) THEN l.qty_g ELSE 0 END) AS expiring_g,
      SUM(CASE WHEN l.expiry IS NULL OR l.expiry>=date('now') THEN l.qty_g/1000.0*l.unit_cost_per_kg ELSE 0 END) AS value
    FROM stock_lots l JOIN foods f ON f.id=l.food_id WHERE l.org_id=? AND l.unit_id=? AND l.qty_g>0 GROUP BY l.food_id, f.name ORDER BY f.name`).bind(`+${expiringDays} days`, a.orgId, unitId).all<any>()).results
  const lv = new Map((await c.env.DB.prepare('SELECT * FROM stock_levels WHERE org_id=? AND unit_id=?').bind(a.orgId, unitId).all<any>()).results.map((l) => [l.food_id, l]))
  const seen = new Set(rows.map((r) => r.food_id))
  const items = rows.map((r) => ({ food_id: r.food_id, name: r.name, available_g: round(r.available_g, 2), expired_g: round(r.expired_g, 2), expiring_g: round(r.expiring_g, 2), value: round(r.value, 2),
    min_g: lv.get(r.food_id)?.min_g ?? null, below_min: lv.get(r.food_id)?.min_g != null && r.available_g < lv.get(r.food_id).min_g }))
  for (const [fid, l] of lv) if (!seen.has(fid) && l.min_g != null && l.min_g > 0) {
    const fd = await c.env.DB.prepare('SELECT name FROM foods WHERE id=?').bind(fid).first<any>()
    items.push({ food_id: fid, name: fd?.name, available_g: 0, expired_g: 0, expiring_g: 0, value: 0, min_g: l.min_g, below_min: true })
  }
  return items
}
uan.get('/stock/balance', need('stock.read'), async (c) => {
  const q = new URL(c.req.url).searchParams, u = await needUnit(c, 'stock.read', q.get('unit_id'))
  const items = await balance(c, u, Number(q.get('expiring_days') ?? 7) || 7)
  return c.json({ items, alerts: { below_min: items.filter((i) => i.below_min).length, with_expired: items.filter((i) => i.expired_g > 0).length, expiring_soon: items.filter((i) => i.expiring_g > 0).length }, total_value: round(items.reduce((s, i) => s + i.value, 0), 2) })
})

// ---------- compras ----------
const parseItems = async (c: AppCtx, items: unknown, withPrice: boolean) => {
  if (!Array.isArray(items) || !items.length) throw bad('missing_field', 'Informe items')
  const out: any[] = []
  for (const it of items.slice(0, 300)) {
    await checkFood(c, it?.food_id)
    const o: any = { food_id: it.food_id, qty_g: positive(it.qty_g, 'qty_g') }
    if (withPrice) { const p = Number(it.price_per_kg); if (!Number.isFinite(p) || p < 0) throw bad('invalid_field', 'price_per_kg inválido'); o.price_per_kg = p }
    out.push(o)
  }
  return out
}
uan.post('/purchase-requests/suggest', need('purchase.read'), async (c) => {
  const b = await readBody(c), u = await needUnit(c, 'purchase.read', b.unit_id)
  const from = String(b.from ?? today()), to = String(b.to ?? from)
  if (!DATE.test(from) || !DATE.test(to)) throw bad('invalid_field', 'Datas inválidas')
  const a = c.get('auth')
  const orders = (await c.env.DB.prepare("SELECT recipe_id, planned_portions FROM production_orders WHERE org_id=? AND unit_id=? AND date>=? AND date<=? AND status='planned'").bind(a.orgId, u, from, to).all<any>()).results
  const need_g = new Map<string, number>(), names = new Map<string, string>()
  for (const o of orders) {
    const calc = await recipeCalc(c.env, a.orgId!, o.recipe_id)
    if (!calc) continue
    for (const i of scaleItems(calc, o.planned_portions)) { need_g.set(i.food_id, (need_g.get(i.food_id) ?? 0) + (i.gross_g || i.net_g)); names.set(i.food_id, i.food_name) }
  }
  const bal = new Map((await balance(c, u)).map((x) => [x.food_id, x]))
  const suggestions: any[] = []
  for (const [fid, qty] of need_g) {
    const have = bal.get(fid)?.available_g ?? 0
    const minG = bal.get(fid)?.min_g ?? 0
    const buy = qty + (minG ?? 0) - have
    if (buy > 0) {
      const pr = await c.env.DB.prepare("SELECT price_per_kg,source FROM food_prices WHERE org_id=? AND food_id=? AND valid_from<=date('now') ORDER BY valid_from DESC LIMIT 1").bind(a.orgId, fid).first<any>()
      suggestions.push({ food_id: fid, name: names.get(fid), needed_g: round(qty, 2), in_stock_g: have, suggested_qty_g: round(buy, 2), estimated_cost: pr ? round((buy / 1000) * pr.price_per_kg, 2) : null, price_source: pr?.source ?? null })
    }
  }
  return c.json({ from, to, production_orders_considered: orders.length, suggestions, note: 'Considera ordens de produção planejadas, saldo não vencido e estoque mínimo. Estimativa só quando há preço cadastrado.' })
})
uan.post('/purchase-requests', need('purchase.write'), async (c) => {
  const b = await readBody(c), u = await needUnit(c, 'purchase.write', b.unit_id)
  const items = await parseItems(c, b.items, false)
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO purchase_requests (id,org_id,unit_id,status,notes,items,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, c.get('auth').orgId, u, 'pending', b.notes ?? null, JSON.stringify(items), c.get('auth').userId, ts, ts).run()
  await audit(c, 'create', 'purchase_requests', id)
  return c.json({ id, status: 'pending' }, 201)
})
uan.get('/purchase-requests', need('purchase.read'), async (c) => {
  const a = c.get('auth'), s = unitScope(a, 'purchase.read')
  const rows = (await c.env.DB.prepare(`SELECT * FROM purchase_requests WHERE org_id=? ${s === null ? '' : `AND unit_id IN (${s.map(() => '?').join(',') || "''"})`} ORDER BY created_at DESC LIMIT 200`).bind(a.orgId, ...(s ?? [])).all<any>()).results
  return c.json({ items: rows.map((r) => ({ ...r, items: JSON.parse(r.items) })) })
})
uan.post('/purchase-requests/:id/approve', need('purchase.approve'), async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM purchase_requests WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!r || !can(c.get('auth'), 'purchase.approve', r.unit_id)) throw notFound('Requisição')
  if (r.status !== 'pending') throw conflict('invalid_state', 'Requisição não está pendente')
  if (r.requested_by === c.get('auth').userId && !(await c.req.json().catch(() => ({}))).allow_self) throw conflict('self_approval', 'Quem solicitou não aprova a própria requisição')
  await c.env.DB.prepare("UPDATE purchase_requests SET status='approved', approved_by=?, updated_at=? WHERE id=?").bind(c.get('auth').userId, nowIso(), r.id).run()
  await audit(c, 'approve', 'purchase_requests', r.id)
  return c.json({ ok: true })
})
uan.post('/purchase-orders', need('purchase.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await needUnit(c, 'purchase.write', b.unit_id)
  if (!(await c.env.DB.prepare('SELECT 1 FROM suppliers WHERE id=? AND org_id=?').bind(String(b.supplier_id ?? ''), a.orgId).first())) throw bad('invalid_reference', 'Fornecedor inválido')
  if (b.request_id) {
    const rq = await c.env.DB.prepare('SELECT status,unit_id FROM purchase_requests WHERE id=? AND org_id=?').bind(String(b.request_id), a.orgId).first<any>()
    if (!rq || rq.unit_id !== u) throw bad('invalid_reference', 'Requisição inválida')
    if (rq.status !== 'approved') throw conflict('request_not_approved', 'A requisição precisa estar aprovada')
  }
  const items = await parseItems(c, b.items, true)
  const id = uid(), ts = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO purchase_orders (id,org_id,unit_id,supplier_id,request_id,status,expected_on,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, a.orgId, u, b.supplier_id, b.request_id ?? null, 'open', b.expected_on ?? null, a.userId, ts, ts),
    ...items.map((i) => c.env.DB.prepare('INSERT INTO purchase_order_items (id,org_id,order_id,food_id,qty_g,price_per_kg,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(uid(), a.orgId, id, i.food_id, i.qty_g, i.price_per_kg, ts, ts))
  ])
  if (b.request_id) await c.env.DB.prepare("UPDATE purchase_requests SET status='ordered', updated_at=? WHERE id=?").bind(ts, b.request_id).run()
  await audit(c, 'create', 'purchase_orders', id)
  return c.json({ id, status: 'open' }, 201)
})
uan.get('/purchase-orders/:id', need('purchase.read'), async (c) => {
  const o = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!o || !can(c.get('auth'), 'purchase.read', o.unit_id)) throw notFound('Pedido')
  const items = (await c.env.DB.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').bind(o.id).all()).results
  return c.json({ ...o, items })
})
uan.get('/purchase-orders', need('purchase.read'), async (c) => {
  const a = c.get('auth'), s = unitScope(a, 'purchase.read')
  const rows = (await c.env.DB.prepare(`SELECT * FROM purchase_orders WHERE org_id=? ${s === null ? '' : `AND unit_id IN (${s.map(() => '?').join(',') || "''"})`} ORDER BY created_at DESC LIMIT 200`).bind(a.orgId, ...(s ?? [])).all()).results
  return c.json({ items: rows })
})
/** Recebimento: cria lotes, registra movimento, e grava o preço pago como preço com fonte rastreável. */
uan.post('/purchase-orders/:id/receive', need('stock.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const o = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!o || !can(a, 'stock.write', o.unit_id)) throw notFound('Pedido')
  if (!['open', 'partial'].includes(o.status)) throw conflict('invalid_state', 'Pedido já recebido/cancelado')
  const recv: any[] = Array.isArray(b.items) ? b.items : []
  if (!recv.length) throw bad('missing_field', 'Informe items [{item_id, received_qty_g, lot_code, expiry}]')
  const lines: { it: any; r: any; q: number }[] = []
  for (const r of recv) {
    const it = await c.env.DB.prepare('SELECT * FROM purchase_order_items WHERE id=? AND order_id=?').bind(String(r.item_id ?? ''), o.id).first<any>()
    if (!it) throw bad('invalid_reference', 'Item não pertence ao pedido')
    const q = positive(r.received_qty_g, 'received_qty_g')
    if ((it.received_qty_g ?? 0) + q > it.qty_g * 1.1 + 1e-9) throw conflict('over_receipt', 'Recebimento excede 10% do solicitado')
    if (!String(r.lot_code ?? '').trim()) throw bad('missing_field', 'lot_code obrigatório no recebimento')
    if (r.expiry && !DATE.test(r.expiry)) throw bad('invalid_field', 'expiry inválida')
    lines.push({ it, r, q })
  }
  for (const { it, r, q } of lines) {
    await addLot(c, { unit_id: o.unit_id, food_id: it.food_id, lot_code: String(r.lot_code), qty_g: q, expiry: r.expiry ?? null, supplier_id: o.supplier_id, cost: it.price_per_kg }, 'entry', 'purchase_order', o.id)
    await c.env.DB.prepare('UPDATE purchase_order_items SET received_qty_g=COALESCE(received_qty_g,0)+?, updated_at=? WHERE id=?').bind(q, nowIso(), it.id).run()
    const ts = nowIso()
    await c.env.DB.prepare('INSERT INTO food_prices (id,org_id,food_id,supplier_id,price_per_kg,source,valid_from,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(uid(), a.orgId, it.food_id, o.supplier_id, it.price_per_kg, `Pedido de compra ${o.id}`, today(), a.userId, ts, ts).run()
  }
  const left = (await c.env.DB.prepare('SELECT COUNT(*) n FROM purchase_order_items WHERE order_id=? AND COALESCE(received_qty_g,0) < qty_g*0.999').bind(o.id).first<any>())?.n ?? 0
  const status = left === 0 ? 'received' : 'partial'
  await c.env.DB.prepare('UPDATE purchase_orders SET status=?, received_at=?, updated_at=? WHERE id=?').bind(status, nowIso(), nowIso(), o.id).run()
  await audit(c, 'receive', 'purchase_orders', o.id, { status })
  return c.json({ status })
})

// ---------- ordens de produção ----------
const prodView = (r: any) => ({ ...r, ingredient_snapshot: JSON.parse(r.ingredient_snapshot), stock_shortfalls: JSON.parse(r.stock_shortfalls) })
uan.post('/production-orders', need('production.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await needUnit(c, 'production.write', b.unit_id)
  if (!DATE.test(String(b.date))) throw bad('invalid_field', 'date inválida')
  if (!MEALS.includes(b.meal_type)) throw bad('invalid_field', 'meal_type inválido')
  const rc = await c.env.DB.prepare('SELECT status FROM recipes WHERE id=? AND org_id=?').bind(String(b.recipe_id ?? ''), a.orgId).first<any>()
  if (!rc) throw bad('invalid_reference', 'Receita inválida')
  if (rc.status !== 'approved') throw bad('recipe_not_approved', 'Somente fichas técnicas aprovadas entram em produção')
  const portions = positive(b.planned_portions, 'planned_portions')
  const calc = (await recipeCalc(c.env, a.orgId!, b.recipe_id))!
  const snap = scaleItems(calc, portions)
  const short: any[] = []
  const bal = new Map((await balance(c, u)).map((x) => [x.food_id, x.available_g]))
  for (const i of snap) { const need_g = i.gross_g || i.net_g; const have = bal.get(i.food_id) ?? 0; if (have + 1e-9 < need_g) short.push({ food_id: i.food_id, name: i.food_name, needed_g: need_g, available_g: have }) }
  const id = uid(), ts = nowIso()
  const planned = calc.cost_complete ? round(calc.cost_per_portion * portions, 2) : null
  await c.env.DB.prepare('INSERT INTO production_orders (id,org_id,unit_id,date,meal_type,menu_id,recipe_id,planned_portions,status,responsible_user_id,shift_id,contract_id,planned_cost,ingredient_snapshot,stock_shortfalls,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, u, b.date, b.meal_type, b.menu_id ?? null, b.recipe_id, portions, 'planned', b.responsible_user_id ?? null, b.shift_id ?? null, b.contract_id ?? null, planned, JSON.stringify(snap), JSON.stringify(short), b.notes ?? null, ts, ts).run()
  await audit(c, 'create', 'production_orders', id)
  return c.json({ ...prodView((await c.env.DB.prepare('SELECT * FROM production_orders WHERE id=?').bind(id).first())!), cost_complete: calc.cost_complete }, 201)
})
uan.get('/production-orders', need('production.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, s = unitScope(a, 'production.read')
  const where = ['org_id=?'], p: unknown[] = [a.orgId]
  if (s !== null) { where.push(`unit_id IN (${s.map(() => '?').join(',') || "''"})`); p.push(...s) }
  for (const k of ['unit_id', 'date', 'status', 'meal_type']) if (q.get(k)) { where.push(`${k}=?`); p.push(q.get(k)) }
  const rows = (await c.env.DB.prepare(`SELECT * FROM production_orders WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT 300`).bind(...p).all<any>()).results
  return c.json({ items: rows.map(prodView) })
})
async function loadProd(c: AppCtx, id: string, perm: string) {
  const o = await c.env.DB.prepare('SELECT * FROM production_orders WHERE id=? AND org_id=?').bind(id, c.get('auth').orgId).first<any>()
  if (!o || !can(c.get('auth'), perm, o.unit_id)) throw notFound('Ordem de produção')
  return o
}
uan.get('/production-orders/:id', need('production.read'), async (c) => c.json(prodView(await loadProd(c, c.req.param('id'), 'production.read'))))
uan.get('/production-orders/:id/export.pdf', need('production.read'), async (c) => {
  const o = prodView(await loadProd(c, c.req.param('id'), 'production.read'))
  const rc = await c.env.DB.prepare('SELECT name FROM recipes WHERE id=?').bind(o.recipe_id).first<any>()
  const k = (x: unknown, d = 1) => (x == null ? '-' : Number(x).toLocaleString('pt-BR', { maximumFractionDigits: d }))
  const bytes = await buildPdf({ title: `Ordem de produção: ${rc?.name ?? o.recipe_id}`, subtitle: `${o.date} - ${o.meal_type} - ${o.planned_portions} porções - status ${o.status}`,
    blocks: [
      ...(o.stock_shortfalls.length ? [{ t: 'alert' as const, text: 'Estoque insuficiente para: ' + o.stock_shortfalls.map((s: any) => `${s.name} (falta ${k(s.needed_g - s.available_g, 0)} g)`).join('; ') }] : []),
      { t: 'table', head: ['Ingrediente', 'Bruto (g)', 'Líquido (g)'], widths: [4, 1, 1], rows: o.ingredient_snapshot.map((i: any) => [i.food_name, k(i.gross_g, 0), k(i.net_g, 0)]) },
      { t: 'kv', rows: [['Custo planejado', o.planned_cost == null ? 'incompleto (faltam preços)' : 'R$ ' + k(o.planned_cost, 2)], ['Custo real', o.actual_cost == null ? '-' : 'R$ ' + k(o.actual_cost, 2)], ['Produzido', o.produced_portions == null ? '-' : String(o.produced_portions)]] }
    ] })
  await audit(c, 'export', 'production_orders', o.id, { format: 'pdf' })
  return pdfResponse(bytes, `producao-${o.id.slice(0, 8)}.pdf`)
})
uan.get('/stock/balance/export.pdf', need('stock.read'), async (c) => {
  const q = new URL(c.req.url).searchParams, u = await needUnit(c, 'stock.read', q.get('unit_id'))
  const items = await balance(c, u, Number(q.get('expiring_days') ?? 7) || 7)
  const k = (x: unknown, d = 0) => (x == null ? '-' : Number(x).toLocaleString('pt-BR', { maximumFractionDigits: d }))
  const bytes = await buildPdf({ title: 'Posição de estoque', subtitle: `Emitido em ${today()} (validade considerada: ${q.get('expiring_days') ?? 7} dias)`, landscape: true,
    blocks: [{ t: 'table', head: ['Alimento', 'Disponível (g)', 'Vencido (g)', 'A vencer (g)', 'Mínimo (g)', 'Valor (R$)', 'Alerta'], widths: [4, 1.2, 1.2, 1.2, 1.2, 1.2, 1.6],
      rows: items.map((i: any) => [i.name, k(i.available_g), k(i.expired_g), k(i.expiring_g), k(i.min_g), k(i.value, 2), [i.below_min ? 'abaixo do mínimo' : '', i.expired_g > 0 ? 'vencido' : ''].filter(Boolean).join(', ')]) }] })
  await audit(c, 'export', 'stock', u, { format: 'pdf' })
  return pdfResponse(bytes, `estoque-${today()}.pdf`)
})
uan.post('/production-orders/:id/start', need('production.write'), async (c) => {
  const o = await loadProd(c, c.req.param('id'), 'production.write')
  if (o.status !== 'planned') throw conflict('invalid_state', 'Somente ordens planejadas podem iniciar')
  const snap: any[] = JSON.parse(o.ingredient_snapshot)
  const miss: any[] = []
  for (const i of snap) { const r = await consume(c, o.unit_id, i.food_id, i.gross_g || i.net_g, 'production', null, 'production_order', o.id, true); if (!r.ok) miss.push({ food_id: i.food_id, name: i.food_name, needed_g: i.gross_g || i.net_g, available_g: r.available_g }) }
  if (miss.length) throw conflict('insufficient_stock', 'Estoque insuficiente para iniciar a produção', miss)
  let cost = 0
  for (const i of snap) cost += (await consume(c, o.unit_id, i.food_id, i.gross_g || i.net_g, 'production', `Produção ${o.id}`, 'production_order', o.id)).cost
  await c.env.DB.prepare("UPDATE production_orders SET status='in_progress', start_at=?, actual_cost=?, stock_shortfalls='[]', updated_at=? WHERE id=?").bind(nowIso(), round(cost, 2), nowIso(), o.id).run()
  await audit(c, 'start', 'production_orders', o.id, { actual_cost: round(cost, 2) })
  return c.json({ ok: true, actual_cost: round(cost, 2) })
})
uan.post('/production-orders/:id/complete', need('production.write'), async (c) => {
  const o = await loadProd(c, c.req.param('id'), 'production.write'), b = await readBody(c)
  if (o.status !== 'in_progress') throw conflict('invalid_state', 'Somente ordens em andamento podem ser concluídas')
  const produced = positive(b.produced_portions, 'produced_portions')
  const leftovers = num(b.leftovers_g, 0), waste = num(b.waste_g, 0)
  if (leftovers < 0 || waste < 0) throw bad('invalid_field', 'Valores negativos')
  const ts = nowIso()
  await c.env.DB.prepare("UPDATE production_orders SET status='done', end_at=?, produced_portions=?, yield_g=?, leftovers_g=?, waste_g=?, updated_at=? WHERE id=?").bind(ts, produced, b.yield_g ?? null, leftovers, waste, ts, o.id).run()
  const rows: [string, number][] = [['sobra_limpa', leftovers], ['desperdicio', waste]]
  for (const [kind, g] of rows) if (g > 0) await c.env.DB.prepare('INSERT INTO waste_records (id,org_id,unit_id,date,kind,recipe_id,qty_g,reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(uid(), o.org_id, o.unit_id, o.date, kind, o.recipe_id, g, `Ordem ${o.id}`, c.get('auth').userId, ts, ts).run()
  await audit(c, 'complete', 'production_orders', o.id)
  return c.json({ ok: true })
})
uan.post('/production-orders/:id/cancel', need('production.write'), async (c) => {
  const o = await loadProd(c, c.req.param('id'), 'production.write')
  if (o.status !== 'planned') throw conflict('invalid_state', 'Somente ordens planejadas podem ser canceladas (estoque já consumido)')
  await c.env.DB.prepare("UPDATE production_orders SET status='cancelled', updated_at=? WHERE id=?").bind(nowIso(), o.id).run()
  await audit(c, 'cancel', 'production_orders', o.id)
  return c.json({ ok: true })
})

// ---------- dimensionamento, previsão e indicadores ----------
/** Dimensionamento parametrizado: todos os parâmetros vêm do usuário (sem padrões inventados). */
uan.post('/uan/dimensioning', need('uan.read'), async (c) => {
  const b = await readBody(c), u = await needUnit(c, 'uan.read', b.unit_id)
  const portions = positive(b.portions_per_meal, 'portions_per_meal'), serviceMin = positive(b.service_minutes, 'service_minutes')
  const prod = positive(b.productivity_portions_per_worker_hour, 'productivity_portions_per_worker_hour')
  const prepHours = positive(b.preparation_hours, 'preparation_hours')
  const workers = Math.ceil(portions / (prod * prepHours))
  const eq = (await c.env.DB.prepare('SELECT name,capacity_portions_per_hour FROM equipment WHERE org_id=? AND unit_id=? AND capacity_portions_per_hour>0').bind(c.get('auth').orgId, u).all<any>()).results
  const need_ph = portions / (serviceMin / 60)
  return c.json({
    inputs: { portions_per_meal: portions, service_minutes: serviceMin, preparation_hours: prepHours, productivity_portions_per_worker_hour: prod },
    workers_needed: workers, portions_per_hour_at_service: round(need_ph, 1),
    equipment: eq.map((e) => ({ name: e.name, capacity_portions_per_hour: e.capacity_portions_per_hour, covers_service_peak: e.capacity_portions_per_hour >= need_ph, units_needed: Math.ceil(need_ph / e.capacity_portions_per_hour) })),
    note: 'Cálculo determinístico a partir dos parâmetros informados; produtividade e horas são premissas do usuário.'
  })
})
export async function forecast(c: AppCtx, unitId: string, mealType: string, date: string, weeks = 8, margin = 0) {
  const wd = new Date(date + 'T00:00:00Z').getUTCDay()
  const since = new Date(Date.parse(date) - weeks * 7 * 86400000).toISOString().slice(0, 10)
  const rows = (await c.env.DB.prepare('SELECT date, SUM(served) AS served FROM meal_counts WHERE org_id=? AND unit_id=? AND meal_type=? AND served IS NOT NULL AND date>=? AND date<? GROUP BY date').bind(c.get('auth').orgId, unitId, mealType, since, date).all<any>()).results
    .filter((r) => new Date(r.date + 'T00:00:00Z').getUTCDay() === wd)
  if (rows.length < 3) return { sufficient: false as const, samples: rows.length, message: 'Histórico insuficiente (mínimo 3 mesmos dias da semana com refeições servidas registradas). Nenhuma previsão foi inventada.' }
  const v = rows.map((r) => r.served as number)
  const mean = v.reduce((s, x) => s + x, 0) / v.length
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1))
  return { sufficient: true as const, method: 'média do mesmo dia da semana nas últimas semanas (estatística simples)', samples: v.length, mean: round(mean, 1), std_dev: round(sd, 1), min: Math.min(...v), max: Math.max(...v),
    suggested_portions: Math.ceil(round(mean * (1 + margin / 100), 6)), margin_pct: margin }
}
uan.get('/uan/demand-forecast', need('uan.read'), async (c) => {
  const q = new URL(c.req.url).searchParams, u = await needUnit(c, 'uan.read', q.get('unit_id'))
  const date = q.get('date') ?? today(), meal = q.get('meal_type') ?? ''
  if (!MEALS.includes(meal as any) || !DATE.test(date)) throw bad('invalid_field', 'meal_type/date inválidos')
  return c.json({ unit_id: u, date, meal_type: meal, ...(await forecast(c, u, meal, date, Number(q.get('weeks') ?? 8) || 8, Number(q.get('margin_pct') ?? 0) || 0)), disclosure: 'Previsão estatística assistiva; decisão final do responsável.' })
})
uan.get('/uan/kpis', needAny('uan.read', 'production.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, u = await needUnit(c, 'uan.read', q.get('unit_id'))
  const from = q.get('from') ?? '0000-01-01', to = q.get('to') ?? '9999-12-31'
  const one = async (sql: string) => (await c.env.DB.prepare(sql).bind(a.orgId, u, from, to).first<any>()) ?? {}
  const mc = await one('SELECT SUM(served) served, SUM(planned) planned FROM meal_counts WHERE org_id=? AND unit_id=? AND date>=? AND date<=?')
  const po = await one("SELECT SUM(actual_cost) cost, SUM(produced_portions) portions, SUM(planned_cost) pcost, SUM(planned_portions) pport, COUNT(*) n FROM production_orders WHERE org_id=? AND unit_id=? AND date>=? AND date<=? AND status='done'")
  const w = await one('SELECT SUM(qty_g) g, SUM(cost) cost FROM waste_records WHERE org_id=? AND unit_id=? AND date>=? AND date<=?')
  const k = (n: number | null | undefined, d: number | null | undefined) => (n != null && d ? round(n / d, 2) : null)
  return c.json({
    period: { from, to }, meals_served: mc.served ?? 0, meals_planned: mc.planned ?? 0, planned_vs_served_pct: mc.planned ? round(((mc.served ?? 0) / mc.planned) * 100, 1) : null,
    production_orders_done: po.n ?? 0, actual_cost_total: round(po.cost ?? 0, 2), actual_cost_per_portion: k(po.cost, po.portions), planned_cost_per_portion: k(po.pcost, po.pport),
    waste_total_g: round(w.g ?? 0, 2), waste_cost: round(w.cost ?? 0, 2), waste_g_per_portion: k(w.g, po.portions)
  })
})

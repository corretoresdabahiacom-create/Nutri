import { Hono } from 'hono'
import { type AppCtx, type AppEnv, assertCan, audit, can, need, needAny, requireUnit, unitScope } from '../lib/auth'
import { f, mountCrud } from '../lib/crud'
import { recipeCalc } from '../lib/calc'
import { decryptValue } from '../lib/crypto'
import { randomToken, sha256Hex } from '../lib/crypto'
import { bad, conflict, nowIso, norm, notFound, num, parseJson, readBody, round, today, uid, csvEscape, toCsv } from '../lib/util'
import { rateLimit } from '../lib/auth'

export const menus = new Hono<AppEnv>()
export const publicMenus = new Hono<AppEnv>()
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MEALS = ['cafe', 'colacao', 'almoco', 'lanche', 'jantar', 'ceia', 'brunch', 'buffet', 'room_service', 'evento'] as const

// ================= cardápios =================
async function loadMenu(c: AppCtx, id: string, perm: string) {
  const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id=? AND org_id=?').bind(id, c.get('auth').orgId).first<any>()
  if (!m || !can(c.get('auth'), perm, m.unit_id)) throw notFound('Cardápio')
  return m
}
async function menuView(c: AppCtx, m: any, forPublic = false) {
  const a = c.get('auth')
  const items = (await c.env.DB.prepare('SELECT * FROM menu_items WHERE menu_id=? ORDER BY date, meal_type, position').bind(m.id).all<any>()).results
  const excludedFoods: string[] = parseJson(m.excluded_food_ids, []), excludedTags: string[] = parseJson(m.excluded_tags, [])
  const out: any[] = []
  let total = 0, complete = true
  const issues: any[] = []
  for (const it of items) {
    const calc = await recipeCalc(c.env, m.org_id, it.recipe_id)
    const rc = await c.env.DB.prepare('SELECT name,status FROM recipes WHERE id=?').bind(it.recipe_id).first<any>()
    const foodIds = calc?.items.map((i) => i.food_id) ?? []
    const viol = [...foodIds.filter((x) => excludedFoods.includes(x)).map((x) => `ingrediente excluído: ${calc?.items.find((i) => i.food_id === x)?.food_name}`),
      ...(calc?.tags ?? []).filter((t) => excludedTags.map(norm).includes(norm(t))).map((t) => `tag excluída: ${t}`)]
    if (viol.length) issues.push({ item_id: it.id, recipe: rc?.name, problems: viol })
    if (rc && rc.status !== 'approved') issues.push({ item_id: it.id, recipe: rc.name, problems: ['ficha técnica não aprovada'] })
    const row: any = { id: it.id, date: it.date, meal_type: it.meal_type, section: it.section, position: it.position, recipe_id: it.recipe_id, recipe: rc?.name, diet_type_id: it.diet_type_id,
      allergens: calc?.allergens ?? [], tags: calc?.tags ?? [], nutrition_per_portion: calc?.nutrition_per_portion ?? null, nutrition_complete: calc?.nutrition_complete ?? false }
    if (!forPublic) {
      const portions = num(it.planned_portions, 0)
      row.planned_portions = it.planned_portions; row.price = it.price
      row.cost_per_portion = calc?.cost_complete ? calc.cost_per_portion : null
      row.cost = calc?.cost_complete && portions ? round(calc.cost_per_portion * portions, 2) : null
      if (calc && !calc.cost_complete) complete = false
      if (row.cost != null) total += row.cost
    } else row.price = it.price
    out.push(row)
  }
  const base: any = { id: m.id, name: m.name, kind: m.kind, status: m.status, version: m.version, menu_key: m.menu_key, date_from: m.date_from, date_to: m.date_to, valid_from: m.valid_from, valid_until: m.valid_until, diet_style: m.diet_style, items: out }
  if (forPublic) return base
  const prof = m.budget_profile_id ? await c.env.DB.prepare('SELECT * FROM budget_profiles WHERE id=? AND org_id=?').bind(m.budget_profile_id, m.org_id).first<any>() : null
  const days = new Set(items.map((i) => i.date).filter(Boolean)).size || 1
  const budget = prof ? { profile: prof.name, limit_per_menu: prof.limit_per_menu, limit_per_day: prof.limit_per_day, per_day_cost: round(total / days, 2),
    exceeds: (prof.limit_per_menu != null && total > prof.limit_per_menu) || (prof.limit_per_day != null && total / days > prof.limit_per_day) } : null
  return { ...base, unit_id: m.unit_id, excluded_food_ids: excludedFoods, excluded_tags: excludedTags, is_template: !!m.is_template, publish_at: m.publish_at, public_token_set: !!m.public_token,
    approved_by: m.approved_by, approved_at: m.approved_at, total_cost: round(total, 2), cost_complete: complete, budget, issues }
}
async function saveItems(c: AppCtx, menuId: string, items: any) {
  if (!Array.isArray(items)) throw bad('invalid_field', 'items deve ser lista')
  const a = c.get('auth'), ts = nowIso(), stmts: D1PreparedStatement[] = [c.env.DB.prepare('DELETE FROM menu_items WHERE menu_id=?').bind(menuId)]
  let pos = 0
  for (const it of items.slice(0, 1000)) {
    if (!(await c.env.DB.prepare('SELECT 1 FROM recipes WHERE id=? AND org_id=?').bind(String(it?.recipe_id ?? ''), a.orgId).first())) throw bad('invalid_reference', 'Receita inválida no cardápio')
    if (it.diet_type_id && !(await c.env.DB.prepare('SELECT 1 FROM diet_types WHERE id=? AND org_id=?').bind(String(it.diet_type_id), a.orgId).first())) throw bad('invalid_reference', 'Dieta inválida')
    if (it.date && !DATE.test(it.date)) throw bad('invalid_field', 'date inválida')
    const meal = it.meal_type ?? 'almoco'
    if (!MEALS.includes(meal)) throw bad('invalid_field', 'meal_type inválido')
    stmts.push(c.env.DB.prepare('INSERT INTO menu_items (id,org_id,menu_id,date,meal_type,section,recipe_id,diet_type_id,position,planned_portions,price,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(uid(), a.orgId, menuId, it.date ?? null, meal, it.section ?? null, it.recipe_id, it.diet_type_id ?? null, it.position ?? pos++, it.planned_portions ?? null, it.price ?? null, ts, ts))
  }
  await c.env.DB.batch(stmts)
}
const MENU_TEXT = (b: any, m: any = {}) => ({
  name: String(b.name ?? m.name ?? '').slice(0, 160), kind: b.kind ?? m.kind ?? 'daily', diet_style: b.diet_style ?? m.diet_style ?? 'any',
  excluded_food_ids: JSON.stringify(Array.isArray(b.excluded_food_ids) ? b.excluded_food_ids : parseJson(m.excluded_food_ids, [])),
  excluded_tags: JSON.stringify(Array.isArray(b.excluded_tags) ? b.excluded_tags : parseJson(m.excluded_tags, [])),
  date_from: 'date_from' in b ? b.date_from : m.date_from ?? null, date_to: 'date_to' in b ? b.date_to : m.date_to ?? null,
  valid_from: 'valid_from' in b ? b.valid_from : m.valid_from ?? null, valid_until: 'valid_until' in b ? b.valid_until : m.valid_until ?? null,
  is_template: b.is_template != null ? (b.is_template ? 1 : 0) : m.is_template ?? 0, budget_profile_id: 'budget_profile_id' in b ? b.budget_profile_id : m.budget_profile_id ?? null
})
menus.get('/menus', need('menus.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, s = unitScope(a, 'menus.read')
  const where = ['org_id=?'], p: unknown[] = [a.orgId]
  if (s !== null) { where.push(`(unit_id IS NULL OR unit_id IN (${s.map(() => '?').join(',') || "''"}))`); p.push(...s) }
  for (const k of ['unit_id', 'status', 'kind']) if (q.get(k)) { where.push(`${k}=?`); p.push(q.get(k)) }
  if (q.get('templates') === '1') where.push('is_template=1')
  const rows = (await c.env.DB.prepare(`SELECT id,name,kind,status,version,menu_key,unit_id,date_from,date_to,is_template,updated_at FROM menus WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 300`).bind(...p).all()).results
  return c.json({ items: rows })
})
menus.get('/menus/:id', need('menus.read'), async (c) => c.json(await menuView(c, await loadMenu(c, c.req.param('id'), 'menus.read'))))
menus.post('/menus', need('menus.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  if (!String(b.name ?? '').trim()) throw bad('missing_field', 'Informe name')
  let unit: string | null = null
  if (b.unit_id) unit = await requireUnit(c, 'menus.write', b.unit_id)
  else if (unitScope(a, 'menus.write') !== null) throw bad('unit_required', 'Informe unit_id')
  if (b.budget_profile_id && !(await c.env.DB.prepare('SELECT 1 FROM budget_profiles WHERE id=? AND org_id=?').bind(b.budget_profile_id, a.orgId).first())) throw bad('invalid_reference', 'Perfil de orçamento inválido')
  const id = uid(), ts = nowIso(), t = MENU_TEXT(b)
  await c.env.DB.prepare('INSERT INTO menus (id,org_id,unit_id,name,kind,diet_style,excluded_food_ids,excluded_tags,date_from,date_to,status,version,menu_key,is_template,valid_from,valid_until,budget_profile_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, unit, t.name, t.kind, t.diet_style, t.excluded_food_ids, t.excluded_tags, t.date_from, t.date_to, 'draft', 1, uid(), t.is_template, t.valid_from, t.valid_until, t.budget_profile_id, a.userId, ts, ts).run()
  if (b.items) await saveItems(c, id, b.items)
  await audit(c, 'create', 'menus', id)
  return c.json(await menuView(c, (await c.env.DB.prepare('SELECT * FROM menus WHERE id=?').bind(id).first())!), 201)
})
menus.put('/menus/:id', need('menus.write'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.write'), b = await readBody(c)
  if (m.status !== 'draft') throw conflict('not_draft', 'Somente rascunhos podem ser editados. Use /menus/:id/revise para nova versão.')
  const t = MENU_TEXT(b, m)
  await c.env.DB.prepare('UPDATE menus SET name=?,kind=?,diet_style=?,excluded_food_ids=?,excluded_tags=?,date_from=?,date_to=?,valid_from=?,valid_until=?,is_template=?,budget_profile_id=?,updated_at=? WHERE id=?')
    .bind(t.name, t.kind, t.diet_style, t.excluded_food_ids, t.excluded_tags, t.date_from, t.date_to, t.valid_from, t.valid_until, t.is_template, t.budget_profile_id, nowIso(), m.id).run()
  if (b.items !== undefined) await saveItems(c, m.id, b.items)
  await audit(c, 'update', 'menus', m.id, { items_replaced: b.items !== undefined })
  return c.json(await menuView(c, (await c.env.DB.prepare('SELECT * FROM menus WHERE id=?').bind(m.id).first())!))
})
/** Reordenação / troca de item por arrastar-e-soltar: move um item para (date, meal_type, position). */
menus.post('/menus/:id/move-item', need('menus.write'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.write'), b = await readBody(c)
  if (m.status !== 'draft') throw conflict('not_draft', 'Somente rascunhos podem ser editados')
  const it = await c.env.DB.prepare('SELECT * FROM menu_items WHERE id=? AND menu_id=?').bind(String(b.item_id ?? ''), m.id).first<any>()
  if (!it) throw notFound('Item')
  const meal = b.meal_type ?? it.meal_type
  if (!MEALS.includes(meal)) throw bad('invalid_field', 'meal_type inválido')
  await c.env.DB.prepare('UPDATE menu_items SET date=?, meal_type=?, position=?, updated_at=? WHERE id=?').bind('date' in b ? b.date : it.date, meal, Number(b.position ?? it.position), nowIso(), it.id).run()
  return c.json({ ok: true })
})
menus.post('/menus/:id/approve', need('menus.approve'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.approve'), a = c.get('auth')
  if (m.status !== 'draft') throw conflict('invalid_state', 'Somente rascunhos podem ser aprovados')
  const v = await menuView(c, m)
  if (!v.items.length) throw bad('no_items', 'Cardápio sem itens')
  if (v.issues.length) throw conflict('menu_issues', 'Há itens com restrição violada ou ficha não aprovada', v.issues)
  const ts = nowIso()
  await c.env.DB.prepare("UPDATE menus SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?").bind(a.userId, ts, ts, m.id).run()
  await audit(c, 'approve', 'menus', m.id)
  return c.json({ ok: true, budget_exceeded: !!v.budget?.exceeds, warning: v.budget?.exceeds ? 'Custo acima do perfil de orçamento' : undefined })
})
menus.post('/menus/:id/publish', need('menus.publish'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.publish'), a = c.get('auth'), b = await readBody(c)
  if (m.status !== 'approved') throw conflict('not_approved', 'Somente cardápios aprovados podem ser publicados')
  const ts = nowIso()
  const scheduled = b.publish_at && Date.parse(b.publish_at) > Date.now()
  if (b.publish_at && Number.isNaN(Date.parse(b.publish_at))) throw bad('invalid_field', 'publish_at inválido')
  const token = b.public === false ? null : randomToken(24)
  const hash = token ? await sha256Hex(token) : null
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE menus SET status='archived', public_token=NULL, updated_at=? WHERE org_id=? AND menu_key=? AND id<>? AND status IN ('published','scheduled')").bind(ts, a.orgId, m.menu_key, m.id),
    c.env.DB.prepare('UPDATE menus SET status=?, publish_at=?, published_by=?, public_token=?, updated_at=? WHERE id=?').bind(scheduled ? 'scheduled' : 'published', b.publish_at ?? null, a.userId, hash, ts, m.id)
  ])
  await audit(c, 'publish', 'menus', m.id, { scheduled: !!scheduled })
  return c.json({ ok: true, status: scheduled ? 'scheduled' : 'published', public_path: token ? `/api/public/menus/${token}` : null, note: token ? 'O link público é exibido apenas agora.' : undefined }, 200)
})
menus.post('/menus/:id/unpublish', need('menus.publish'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.publish')
  if (!['published', 'scheduled'].includes(m.status)) throw conflict('invalid_state', 'Cardápio não está publicado')
  await c.env.DB.prepare("UPDATE menus SET status='approved', public_token=NULL, updated_at=? WHERE id=?").bind(nowIso(), m.id).run()
  await audit(c, 'unpublish', 'menus', m.id)
  return c.json({ ok: true })
})
menus.post('/menus/:id/revise', need('menus.write'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.write'), a = c.get('auth')
  if (m.status === 'draft') throw conflict('already_draft', 'Já é um rascunho')
  const id = uid(), ts = nowIso(), ver = (await c.env.DB.prepare('SELECT MAX(version) v FROM menus WHERE org_id=? AND menu_key=?').bind(a.orgId, m.menu_key).first<any>())?.v + 1
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO menus (id,org_id,unit_id,name,kind,diet_style,excluded_food_ids,excluded_tags,date_from,date_to,status,version,menu_key,is_template,valid_from,valid_until,budget_profile_id,created_by,created_at,updated_at) SELECT ?,org_id,unit_id,name,kind,diet_style,excluded_food_ids,excluded_tags,date_from,date_to,'draft',?,menu_key,is_template,valid_from,valid_until,budget_profile_id,?,?,? FROM menus WHERE id=?").bind(id, ver, a.userId, ts, ts, m.id),
    c.env.DB.prepare("INSERT INTO menu_items (id,org_id,menu_id,date,meal_type,section,recipe_id,diet_type_id,position,planned_portions,price,created_at,updated_at) SELECT lower(hex(randomblob(16))),org_id,?,date,meal_type,section,recipe_id,diet_type_id,position,planned_portions,price,?,? FROM menu_items WHERE menu_id=?").bind(id, ts, ts, m.id)
  ])
  await audit(c, 'revise', 'menus', id, { from: m.id })
  return c.json(await menuView(c, (await c.env.DB.prepare('SELECT * FROM menus WHERE id=?').bind(id).first())!), 201)
})
menus.post('/menus/:id/duplicate', need('menus.write'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.write'), a = c.get('auth'), b = await readBody(c)
  const id = uid(), ts = nowIso()
  const shift = Number(b.shift_days ?? 0) || 0
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO menus (id,org_id,unit_id,name,kind,diet_style,excluded_food_ids,excluded_tags,date_from,date_to,status,version,menu_key,is_template,budget_profile_id,created_by,created_at,updated_at) SELECT ?,org_id,unit_id,?,kind,diet_style,excluded_food_ids,excluded_tags,CASE WHEN date_from IS NULL THEN NULL ELSE date(date_from, ?) END,CASE WHEN date_to IS NULL THEN NULL ELSE date(date_to, ?) END,'draft',1,?,?,budget_profile_id,?,?,? FROM menus WHERE id=?")
      .bind(id, String(b.name ?? m.name + ' (cópia)').slice(0, 160), `${shift} days`, `${shift} days`, uid(), b.as_template ? 1 : 0, a.userId, ts, ts, m.id),
    c.env.DB.prepare("INSERT INTO menu_items (id,org_id,menu_id,date,meal_type,section,recipe_id,diet_type_id,position,planned_portions,price,created_at,updated_at) SELECT lower(hex(randomblob(16))),org_id,?,CASE WHEN date IS NULL THEN NULL ELSE date(date, ?) END,meal_type,section,recipe_id,diet_type_id,position,planned_portions,price,?,? FROM menu_items WHERE menu_id=?").bind(id, `${shift} days`, ts, ts, m.id)
  ])
  await audit(c, 'duplicate', 'menus', id, { from: m.id })
  return c.json(await menuView(c, (await c.env.DB.prepare('SELECT * FROM menus WHERE id=?').bind(id).first())!), 201)
})
menus.delete('/menus/:id', need('menus.write'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.write')
  if (m.status !== 'draft') throw conflict('not_draft', 'Somente rascunhos podem ser excluídos')
  await c.env.DB.prepare('DELETE FROM menu_items WHERE menu_id=?').bind(m.id).run()
  await c.env.DB.prepare('DELETE FROM menus WHERE id=?').bind(m.id).run()
  await audit(c, 'delete', 'menus', m.id)
  return c.json({ ok: true })
})
menus.get('/menus/:id/export.csv', need('menus.read'), async (c) => {
  const m = await loadMenu(c, c.req.param('id'), 'menus.read')
  const v = await menuView(c, m)
  const csv = toCsv(v.items.map((i: any) => ({ data: i.date ?? '', refeicao: i.meal_type, secao: i.section ?? '', preparacao: i.recipe ?? '', alergenos: i.allergens.join('; '), kcal_porcao: i.nutrition_per_portion?.energy_kcal ?? '', custo_porcao: i.cost_per_portion ?? '' })),
    ['data', 'refeicao', 'secao', 'preparacao', 'alergenos', 'kcal_porcao', 'custo_porcao'])
  await audit(c, 'export', 'menus', m.id, { format: 'csv' })
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="cardapio-${m.id.slice(0, 8)}.csv"`, 'Cache-Control': 'no-store' } })
})

/** Endpoint público (sem login): só cardápio publicado, vigente e acessado pelo token; sem custos nem dados de pacientes. */
publicMenus.get('/public/menus/:token', async (c) => {
  await rateLimit(c.env, 'pubmenu:' + (c.req.header('CF-Connecting-IP') ?? 'x'), 120, 60)
  const hash = await sha256Hex(c.req.param('token'))
  const m = await c.env.DB.prepare("SELECT * FROM menus WHERE public_token=? AND status='published'").bind(hash).first<any>()
  const t = today()
  if (!m || (m.valid_from && m.valid_from > t) || (m.valid_until && m.valid_until < t)) throw notFound('Cardápio')
  c.header('Cache-Control', 'public, max-age=60')
  return c.json(await menuView(c as any, m, true))
})

// ================= restaurante =================
const RW = { read: 'restaurant.read', write: 'restaurant.write' }
mountCrud(menus, { table: 'sales', path: 'sales', ...RW, unit: 'strict', unitReq: true, filters: ['unit_id', 'recipe_id'], order: 'date DESC',
  fields: [f.d('date', { req: true }), f.s('recipe_id', { req: true, ref: 'recipes', max: 64 }), f.r('qty', { req: true }), f.r('revenue', { req: true }), f.s('source', { enum: ['manual', 'csv', 'pdv'] })] })
menus.post('/sales/import', need('restaurant.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await requireUnit(c, 'restaurant.write', b.unit_id)
  const rows: any[] = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length || rows.length > 5000) throw bad('invalid_field', 'Informe rows (1..5000): {date, recipe_id|recipe_name, qty, revenue}')
  const errors: any[] = [], ok: any[] = []
  for (const [i, r] of rows.entries()) {
    const rec = r.recipe_id ? await c.env.DB.prepare('SELECT id FROM recipes WHERE id=? AND org_id=?').bind(r.recipe_id, a.orgId).first<any>()
      : await c.env.DB.prepare("SELECT id FROM recipes WHERE org_id=? AND name=? AND status='approved' LIMIT 1").bind(a.orgId, String(r.recipe_name ?? '')).first<any>()
    if (!rec || !DATE.test(String(r.date)) || !(Number(r.qty) > 0) || !(Number(r.revenue) >= 0)) { errors.push({ row: i + 1, error: 'linha inválida ou receita não encontrada' }); continue }
    ok.push({ ...r, recipe_id: rec.id })
  }
  if (errors.length && !b.skip_invalid) throw bad('import_errors', 'Há linhas inválidas (use skip_invalid:true para ignorá-las)', errors.slice(0, 50))
  const ts = nowIso()
  for (let i = 0; i < ok.length; i += 50) await c.env.DB.batch(ok.slice(i, i + 50).map((r) => c.env.DB.prepare("INSERT INTO sales (id,org_id,unit_id,date,recipe_id,qty,revenue,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'csv',?,?)").bind(uid(), a.orgId, u, r.date, r.recipe_id, Number(r.qty), Number(r.revenue), ts, ts)))
  await audit(c, 'import', 'sales', undefined, { imported: ok.length, skipped: errors.length })
  return c.json({ imported: ok.length, skipped: errors.length, errors: errors.slice(0, 50) }, 201)
})
menus.get('/restaurant/margins', need('restaurant.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, u = await requireUnit(c, 'restaurant.read', q.get('unit_id'))
  const from = q.get('from') ?? '0000-01-01', to = q.get('to') ?? '9999-12-31'
  const rows = (await c.env.DB.prepare('SELECT s.recipe_id, r.name, SUM(s.qty) qty, SUM(s.revenue) revenue FROM sales s JOIN recipes r ON r.id=s.recipe_id WHERE s.org_id=? AND s.unit_id=? AND s.date>=? AND s.date<=? GROUP BY s.recipe_id, r.name').bind(a.orgId, u, from, to).all<any>()).results
  const items: any[] = []
  for (const r of rows) {
    const calc = await recipeCalc(c.env, a.orgId!, r.recipe_id)
    const cost = calc?.cost_complete ? round(calc.cost_per_portion * r.qty, 2) : null
    items.push({ recipe_id: r.recipe_id, name: r.name, qty: r.qty, revenue: round(r.revenue, 2), cost, margin: cost != null ? round(r.revenue - cost, 2) : null,
      margin_pct: cost != null && r.revenue > 0 ? round(((r.revenue - cost) / r.revenue) * 100, 1) : null, cost_note: cost == null ? 'Custo incompleto: faltam preços de ingredientes' : undefined })
  }
  items.sort((x, y) => (y.margin ?? -Infinity) - (x.margin ?? -Infinity))
  const withCost = items.filter((i) => i.cost != null)
  const rev = withCost.reduce((s, i) => s + i.revenue, 0), cst = withCost.reduce((s, i) => s + i.cost, 0)
  const pr = (await c.env.DB.prepare("SELECT SUM(planned_cost) pc, SUM(actual_cost) ac FROM production_orders WHERE org_id=? AND unit_id=? AND date>=? AND date<=? AND status='done'").bind(a.orgId, u, from, to).first<any>()) ?? {}
  return c.json({ items, totals: { revenue_with_cost: round(rev, 2), cost: round(cst, 2), margin: round(rev - cst, 2), margin_pct: rev > 0 ? round(((rev - cst) / rev) * 100, 1) : null },
    planned_vs_actual_cost: { planned: pr.pc ?? null, actual: pr.ac ?? null, variance: pr.pc != null && pr.ac != null ? round(pr.ac - pr.pc, 2) : null } })
})

// ================= hotelaria / resort =================
const HW = { read: 'hospitality.read', write: 'hospitality.write' }
mountCrud(menus, { table: 'occupancy_forecasts', path: 'occupancy', ...HW, unit: 'strict', unitReq: true, filters: ['unit_id'], order: 'date DESC',
  fields: [f.d('date', { req: true }), f.i('rooms_occupied'), f.i('adults'), f.i('children'), f.s('source', { enum: ['manual', 'pms'] })] })
mountCrud(menus, { table: 'catering_events', path: 'catering-events', ...HW, unit: 'strict', unitReq: true, filters: ['unit_id'], order: 'date ASC',
  fields: [f.s('name', { req: true, max: 160 }), f.d('date', { req: true }), f.s('meal_type', { enum: MEALS }), f.i('guests'), f.r('budget'), f.s('menu_id', { ref: 'menus', max: 64 }), f.s('notes', { max: 1000 })] })
mountCrud(menus, { table: 'guest_restrictions', path: 'guest-restrictions', read: 'guests.read', write: 'guests.write', unit: 'strict', unitReq: true, filters: ['unit_id'], order: 'created_at DESC', auditRead: true,
  fields: [f.s('guest_ref', { req: true, max: 80 }), f.s('room', { max: 20 }), f.d('stay_from'), f.d('stay_to'), f.j('allergies', { enc: true }), f.j('intolerances', { enc: true }), f.j('preferences', { enc: true }),
    f.j('cultural_religious', { enc: true }), f.b('consent_given', { req: true }), f.s('source', { ro: true }), f.ts('consent_at', { ro: true })],
  hooks: {
    beforeWrite(c, d, ex) {
      if ('consent_given' in d && !d.consent_given) throw bad('consent_required', 'O consentimento do hóspede é obrigatório para registrar restrições (LGPD)')
      if (!ex) { (d as any).consent_at = nowIso(); (d as any).source = 'staff' }
    }
  } })
menus.post('/guest-links', need('guests.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await requireUnit(c, 'guests.write', b.unit_id)
  if (!String(b.guest_ref ?? '').trim()) throw bad('missing_field', 'Informe guest_ref')
  const ttl = Math.min(Math.max(Number(b.ttl_hours ?? 72) || 72, 1), 24 * 30)
  const token = randomToken(24), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO guest_links (id,org_id,unit_id,guest_ref,token_hash,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(uid(), a.orgId, u, String(b.guest_ref).slice(0, 80), await sha256Hex(token), new Date(Date.now() + ttl * 3600_000).toISOString(), a.userId, ts, ts).run()
  await audit(c, 'create', 'guest_links', undefined, { guest_ref: b.guest_ref })
  return c.json({ token, path: `/api/public/guest-form/${token}`, expires_in_hours: ttl, note: 'O token é exibido apenas agora.' }, 201)
})
async function loadLink(c: AppCtx, token: string) {
  await rateLimit(c.env, 'guestform:' + (c.req.header('CF-Connecting-IP') ?? 'x'), 30, 60)
  const l = await c.env.DB.prepare('SELECT * FROM guest_links WHERE token_hash=?').bind(await sha256Hex(token)).first<any>()
  if (!l || l.used_at || l.expires_at < nowIso()) throw notFound('Link')
  return l
}
publicMenus.get('/public/guest-form/:token', async (c) => { await loadLink(c, c.req.param('token')); return c.json({ ok: true, fields: ['allergies', 'intolerances', 'preferences', 'cultural_religious', 'room', 'consent_given'], notice: 'Você controla estes dados: informe apenas o necessário e confirme o consentimento.' }) })
publicMenus.post('/public/guest-form/:token', async (c) => {
  const l = await loadLink(c, c.req.param('token')), b = await readBody(c)
  if (b.consent_given !== true) throw bad('consent_required', 'Consentimento obrigatório')
  const { encryptValue } = await import('../lib/crypto')
  const id = uid(), ts = nowIso()
  const enc = async (name: string, v: unknown) => (v == null ? null : encryptValue(c.env, Array.isArray(v) ? v.slice(0, 30).map((x) => String(x).slice(0, 80)) : [String(v).slice(0, 200)], `guest_restrictions.${name}.${id}`))
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO guest_restrictions (id,org_id,unit_id,guest_ref,room,allergies,intolerances,preferences,cultural_religious,consent_given,consent_at,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,'guest',?,?)")
      .bind(id, l.org_id, l.unit_id, l.guest_ref, b.room ? String(b.room).slice(0, 20) : null, await enc('allergies', b.allergies), await enc('intolerances', b.intolerances), await enc('preferences', b.preferences), await enc('cultural_religious', b.cultural_religious), ts, ts, ts),
    c.env.DB.prepare('UPDATE guest_links SET used_at=?, updated_at=? WHERE id=?').bind(ts, ts, l.id)
  ])
  await c.env.DB.prepare("INSERT INTO audit_log (id,org_id,user_id,action,entity,entity_id,meta,ip,ts) VALUES (?,?,NULL,'guest_submit','guest_restrictions',?,'{}',?,?)").bind(uid(), l.org_id, id, c.req.header('CF-Connecting-IP') ?? null, ts).run().catch(() => {})
  return c.json({ ok: true }, 201)
})
/** Resumo para a cozinha: contagem por restrição entre hóspedes com estadia na data — sem nomes. */
menus.get('/hotel/restrictions-summary', need('guests.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, u = await requireUnit(c, 'guests.read', q.get('unit_id')), date = q.get('date') ?? today()
  const rows = (await c.env.DB.prepare("SELECT * FROM guest_restrictions WHERE org_id=? AND unit_id=? AND consent_given=1 AND (stay_from IS NULL OR stay_from<=?) AND (stay_to IS NULL OR stay_to>=?)").bind(a.orgId, u, date, date).all<any>()).results
  const counts: Record<string, Record<string, number>> = { allergies: {}, intolerances: {}, cultural_religious: {} }
  for (const r of rows) for (const k of Object.keys(counts)) {
    const v = await decryptValue<string[]>(c.env, r[k], `guest_restrictions.${k}.${r.id}`)
    for (const x of v ?? []) { const key = norm(String(x)); counts[k][key] = (counts[k][key] ?? 0) + 1 }
  }
  await audit(c, 'read', 'guest_restrictions', undefined, { summary: true, date })
  return c.json({ date, guests_with_records: rows.length, ...counts })
})
menus.get('/hotel/demand', need('hospitality.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, u = await requireUnit(c, 'hospitality.read', q.get('unit_id')), date = q.get('date') ?? today(), meal = q.get('meal_type') ?? 'cafe'
  const occ = await c.env.DB.prepare('SELECT * FROM occupancy_forecasts WHERE org_id=? AND unit_id=? AND date=?').bind(a.orgId, u, date).first<any>()
  if (!occ) return c.json({ sufficient: false, message: 'Sem previsão de ocupação cadastrada para a data.' })
  const guests = (occ.adults ?? 0) + (occ.children ?? 0)
  const hist = (await c.env.DB.prepare('SELECT SUM(served) s, SUM(guests) g, COUNT(*) n FROM meal_counts WHERE org_id=? AND unit_id=? AND meal_type=? AND served IS NOT NULL AND guests>0 AND date<?').bind(a.orgId, u, meal, date).first<any>()) ?? {}
  let takeUp = q.get('take_up_pct') ? Number(q.get('take_up_pct')) : null, source = 'informado pelo usuário'
  if (takeUp == null && hist.n >= 5 && hist.g > 0) { takeUp = round((hist.s / hist.g) * 100, 1); source = `histórico (${hist.n} registros)` }
  if (takeUp == null || !(takeUp >= 0)) return c.json({ sufficient: false, guests, message: 'Informe take_up_pct ou registre ao menos 5 contagens com hóspedes para estimar adesão. Nada foi inventado.' })
  const evs = (await c.env.DB.prepare('SELECT SUM(guests) g FROM catering_events WHERE org_id=? AND unit_id=? AND date=? AND (meal_type=? OR meal_type IS NULL)').bind(a.orgId, u, date, meal).first<any>())?.g ?? 0
  return c.json({ sufficient: true, date, meal_type: meal, in_house_guests: guests, take_up_pct: takeUp, take_up_source: source, in_house_portions: Math.ceil(round((guests * takeUp) / 100, 6)), event_guests: evs, total_portions: Math.ceil(round((guests * takeUp) / 100, 6)) + evs })
})

// ================= consolidação multiunidade =================
menus.get('/consolidated/costs', need('reports.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, s = unitScope(a, 'reports.read')
  const from = q.get('from') ?? '0000-01-01', to = q.get('to') ?? '9999-12-31'
  const units = (await c.env.DB.prepare('SELECT id,name,kind FROM units WHERE org_id=?').bind(a.orgId).all<any>()).results.filter((x) => s === null || s.includes(x.id))
  const items: any[] = []
  for (const un of units) {
    const g = async (sql: string) => (await c.env.DB.prepare(sql).bind(a.orgId, un.id, from, to).first<any>()) ?? {}
    const p = await g("SELECT SUM(actual_cost) cost, SUM(produced_portions) portions FROM production_orders WHERE org_id=? AND unit_id=? AND date>=? AND date<=? AND status='done'")
    const w = await g('SELECT SUM(qty_g) g, SUM(cost) cost FROM waste_records WHERE org_id=? AND unit_id=? AND date>=? AND date<=?')
    const sl = await g('SELECT SUM(revenue) rev FROM sales WHERE org_id=? AND unit_id=? AND date>=? AND date<=?')
    if (p.cost == null && w.g == null && sl.rev == null) continue
    items.push({ unit_id: un.id, unit: un.name, kind: un.kind, production_cost: round(p.cost ?? 0, 2), portions: p.portions ?? 0, cost_per_portion: p.portions ? round(p.cost / p.portions, 2) : null, waste_g: w.g ?? 0, waste_cost: round(w.cost ?? 0, 2), revenue: round(sl.rev ?? 0, 2) })
  }
  const tot = items.reduce((t, i) => ({ production_cost: t.production_cost + i.production_cost, portions: t.portions + i.portions, waste_g: t.waste_g + i.waste_g, revenue: t.revenue + i.revenue }), { production_cost: 0, portions: 0, waste_g: 0, revenue: 0 })
  return c.json({ period: { from, to }, units: items, total: { ...tot, production_cost: round(tot.production_cost, 2), revenue: round(tot.revenue, 2), cost_per_portion: tot.portions ? round(tot.production_cost / tot.portions, 2) : null } })
})
export { csvEscape }

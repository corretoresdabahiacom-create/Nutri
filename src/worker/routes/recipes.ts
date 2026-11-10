import { Hono } from 'hono'
import { type AppEnv, audit, need } from '../lib/auth'
import { loadRow, type Res } from '../lib/crud'
import { recipeCalc } from '../lib/calc'
import { bad, conflict, forbidden, nowIso, notFound, parseJson, readBody, uid, round } from '../lib/util'

export const recipes = new Hono<AppEnv>()
const RES: Res = { table: 'recipes', path: 'recipes', read: 'recipes.read', write: 'recipes.write', unit: 'loose', fields: [] }

const FIELDS = ['name', 'category', 'description', 'method', 'storage', 'shelf_life', 'consistency', 'photo_doc_id', 'unit_id'] as const

async function recipeData(c: any, b: Record<string, any>, partial: boolean) {
  const a = c.get('auth')
  const d: Record<string, any> = {}
  for (const k of FIELDS) if (k in b) d[k] = b[k] == null || b[k] === '' ? null : String(b[k]).slice(0, k === 'method' || k === 'description' ? 8000 : 300)
  for (const k of ['prep_minutes']) if (k in b) d[k] = b[k] == null ? null : Math.max(0, Math.round(Number(b[k]) || 0))
  for (const k of ['yield_g', 'portions', 'portion_g', 'sale_price']) if (k in b) {
    if (b[k] == null || b[k] === '') { d[k] = k === 'portions' ? 1 : k === 'yield_g' ? 0 : null; continue }
    const n = Number(b[k])
    if (!Number.isFinite(n) || n < 0 || (k === 'portions' && n <= 0)) throw bad('invalid_field', `Campo ${k} inválido`)
    d[k] = n
  }
  for (const k of ['equipment', 'diet_tags']) if (k in b) { if (!Array.isArray(b[k])) throw bad('invalid_field', `${k} deve ser lista`); d[k] = JSON.stringify(b[k].map(String)) }
  if (!partial && !d.name) throw bad('missing_field', 'Campo obrigatório: name')
  if (d.unit_id && !(await c.env.DB.prepare('SELECT 1 FROM units WHERE id=? AND org_id=?').bind(d.unit_id, a.orgId).first())) throw bad('invalid_reference', 'Unidade inválida')
  if (d.photo_doc_id && !(await c.env.DB.prepare('SELECT 1 FROM documents WHERE id=? AND org_id=?').bind(d.photo_doc_id, a.orgId).first())) throw bad('invalid_reference', 'Documento (foto) inválido')
  return d
}

async function validateItems(c: any, items: unknown) {
  if (!Array.isArray(items)) throw bad('invalid_field', 'items deve ser uma lista')
  if (items.length > 200) throw bad('invalid_field', 'Itens demais')
  const a = c.get('auth')
  const out: any[] = []
  for (const it of items) {
    const net = Number(it?.net_g)
    if (!it?.food_id || !Number.isFinite(net) || net <= 0) throw bad('invalid_item', 'Cada item exige food_id e net_g > 0')
    if (!(await c.env.DB.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(String(it.food_id), a.orgId).first())) throw bad('invalid_reference', 'Alimento inválido em item')
    const gross = it.gross_g == null || it.gross_g === '' ? null : Number(it.gross_g)
    const fc = it.correction_factor == null || it.correction_factor === '' ? null : Number(it.correction_factor)
    if ((gross != null && (!Number.isFinite(gross) || gross < 0)) || (fc != null && (!Number.isFinite(fc) || fc <= 0))) throw bad('invalid_item', 'gross_g/correction_factor inválidos')
    out.push({ food_id: String(it.food_id), net_g: net, gross_g: gross, correction_factor: fc, unit: String(it.unit ?? 'g').slice(0, 10), notes: it.notes ? String(it.notes).slice(0, 300) : null })
  }
  return out
}
const itemStmts = (c: any, recipeId: string, items: any[]) => {
  const ts = nowIso(), a = c.get('auth')
  return items.map((i) => c.env.DB.prepare('INSERT INTO recipe_items (id,org_id,recipe_id,food_id,gross_g,net_g,correction_factor,unit,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(uid(), a.orgId, recipeId, i.food_id, i.gross_g, i.net_g, i.correction_factor, i.unit, i.notes, ts, ts))
}
function recipeOut(r: any) {
  return {
    id: r.id, recipe_key: r.recipe_key, version: r.version, status: r.status, unit_id: r.unit_id, name: r.name, category: r.category, description: r.description,
    method: r.method, prep_minutes: r.prep_minutes, yield_g: r.yield_g, portions: r.portions, portion_g: r.portion_g, consistency: r.consistency,
    diet_tags: parseJson(r.diet_tags, []), equipment: parseJson(r.equipment, []), storage: r.storage, shelf_life: r.shelf_life, photo_doc_id: r.photo_doc_id,
    sale_price: r.sale_price, owner_user_id: r.owner_user_id, approved_by: r.approved_by, approved_at: r.approved_at,
    nutrition_reviewed: !!r.nutrition_reviewed, allergens_reviewed: !!r.allergens_reviewed, created_at: r.created_at, updated_at: r.updated_at
  }
}
async function full(c: any, row: any) {
  const a = c.get('auth')
  return { ...recipeOut(row), calc: await recipeCalc(c.env, a.orgId!, row.id) }
}

recipes.get('/recipes', need('recipes.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const where = ['org_id=?'], params: unknown[] = [a.orgId]
  for (const k of ['status', 'category', 'recipe_key']) if (q.get(k)) { where.push(`${k}=?`); params.push(q.get(k)) }
  if (q.get('q')) { where.push('name LIKE ?'); params.push(`%${q.get('q')!.replace(/[%_]/g, '')}%`) }
  if (q.get('current') === '1') where.push("status IN ('draft','approved')")
  const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 200)
  const rows = (await c.env.DB.prepare(`SELECT * FROM recipes WHERE ${where.join(' AND ')} ORDER BY name, version DESC LIMIT ?`).bind(...params, limit).all<any>()).results
  const items = []
  for (const r of rows) items.push(q.get('with_cost') === '1' ? await full(c, r) : recipeOut(r))
  return c.json({ items, total: items.length })
})
recipes.get('/recipes/compare', need('recipes.read'), async (c) => {
  const a = c.get('auth')
  const ids = (new URL(c.req.url).searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 10)
  const out = []
  for (const id of ids) {
    const r = await c.env.DB.prepare('SELECT * FROM recipes WHERE id=? AND org_id=?').bind(id, a.orgId).first<any>()
    if (!r) throw notFound('Receita')
    const calc = await recipeCalc(c.env, a.orgId!, id)
    out.push({ id, name: r.name, version: r.version, status: r.status, total_cost: calc?.total_cost, cost_per_portion: calc?.cost_per_portion, cost_per_kg: calc?.cost_per_kg, nutrition_per_portion: calc?.nutrition_per_portion, allergens: calc?.allergens, cost_complete: calc?.cost_complete })
  }
  return c.json({ items: out })
})
recipes.get('/recipes/:id', need('recipes.read'), async (c) => {
  const row = await loadRow(c, RES, c.req.param('id'))
  const items = (await c.env.DB.prepare('SELECT id,food_id,gross_g,net_g,correction_factor,unit,notes FROM recipe_items WHERE recipe_id=? AND org_id=?').bind(row.id, c.get('auth').orgId).all()).results
  return c.json({ ...(await full(c, row)), items })
})
recipes.get('/recipes/:id/versions', need('recipes.read'), async (c) => {
  const row = await loadRow(c, RES, c.req.param('id'))
  const r = await c.env.DB.prepare('SELECT * FROM recipes WHERE org_id=? AND recipe_key=? ORDER BY version DESC').bind(c.get('auth').orgId, row.recipe_key).all<any>()
  return c.json({ items: r.results.map(recipeOut) })
})

recipes.post('/recipes', need('recipes.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const d = await recipeData(c, b, false)
  if (d.unit_id) { /* escopo por unidade */ }
  const items = b.items ? await validateItems(c, b.items) : []
  const id = uid(), ts = nowIso()
  const cols = ['id', 'org_id', 'recipe_key', 'version', 'status', 'owner_user_id', 'created_at', 'updated_at', ...Object.keys(d)]
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO recipes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(id, a.orgId, uid(), 1, 'draft', a.userId, ts, ts, ...Object.values(d)),
    ...itemStmts(c, id, items)
  ])
  await audit(c, 'create', 'recipes', id, { items: items.length })
  const row = await c.env.DB.prepare('SELECT * FROM recipes WHERE id=?').bind(id).first()
  return c.json(await full(c, row), 201)
})

recipes.put('/recipes/:id', need('recipes.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const row = await loadRow(c, RES, c.req.param('id'), 'recipes.write')
  if (row.status !== 'draft') throw conflict('approved_immutable', 'Receita aprovada/arquivada não pode ser alterada. Crie uma nova versão (POST /recipes/:id/versions).')
  const d = await recipeData(c, b, true)
  const stmts: D1PreparedStatement[] = []
  const keys = Object.keys(d)
  // qualquer edição invalida revisões anteriores
  const extra = { nutrition_reviewed: 0, allergens_reviewed: 0 }
  stmts.push(c.env.DB.prepare(`UPDATE recipes SET ${[...keys, 'nutrition_reviewed', 'allergens_reviewed'].map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=? AND org_id=?`)
    .bind(...Object.values(d), extra.nutrition_reviewed, extra.allergens_reviewed, nowIso(), row.id, a.orgId))
  if (b.items !== undefined) {
    const items = await validateItems(c, b.items)
    stmts.push(c.env.DB.prepare('DELETE FROM recipe_items WHERE recipe_id=? AND org_id=?').bind(row.id, a.orgId), ...itemStmts(c, row.id, items))
  }
  await c.env.DB.batch(stmts)
  await audit(c, 'update', 'recipes', row.id, { fields: keys, items_replaced: b.items !== undefined })
  return c.json(await full(c, await c.env.DB.prepare('SELECT * FROM recipes WHERE id=?').bind(row.id).first()))
})

recipes.post('/recipes/:id/approve', need('recipes.approve'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const row = await loadRow(c, RES, c.req.param('id'), 'recipes.approve')
  if (row.status !== 'draft') throw conflict('invalid_state', 'Somente rascunhos podem ser aprovados')
  const calc = await recipeCalc(c.env, a.orgId!, row.id)
  if (!calc || calc.items.length === 0) throw bad('no_items', 'Receita sem ingredientes não pode ser aprovada')
  if (b.nutrition_reviewed !== true || b.allergens_reviewed !== true) throw bad('review_required', 'Confirme a revisão da composição nutricional e dos alérgenos (nutrition_reviewed e allergens_reviewed = true)')
  if (!calc.nutrition_complete && b.accept_incomplete_nutrition !== true) {
    throw bad('incomplete_nutrition', `Há alimentos sem composição nutricional completa: ${calc.missing_nutrition.join(', ')}. Complete os dados ou envie accept_incomplete_nutrition:true (a informação nutricional não será publicada).`)
  }
  const ts = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE recipes SET status='archived', updated_at=? WHERE org_id=? AND recipe_key=? AND status='approved'").bind(ts, a.orgId, row.recipe_key),
    c.env.DB.prepare("UPDATE recipes SET status='approved', approved_by=?, approved_at=?, nutrition_reviewed=?, allergens_reviewed=1, updated_at=? WHERE id=?").bind(a.userId, ts, calc.nutrition_complete ? 1 : 0, ts, row.id)
  ])
  await audit(c, 'approve', 'recipes', row.id, { version: row.version, nutrition_complete: calc.nutrition_complete, cost_complete: calc.cost_complete })
  return c.json(await full(c, await c.env.DB.prepare('SELECT * FROM recipes WHERE id=?').bind(row.id).first()))
})

async function copyRecipe(c: any, row: any, opts: { newKey: boolean; name?: string }) {
  const a = c.get('auth')
  const id = uid(), ts = nowIso()
  let version = 1
  if (!opts.newKey) version = ((await c.env.DB.prepare('SELECT MAX(version) AS v FROM recipes WHERE org_id=? AND recipe_key=?').bind(a.orgId, row.recipe_key).first())?.v ?? 0) + 1
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO recipes (id,org_id,unit_id,recipe_key,version,status,name,category,description,method,prep_minutes,yield_g,portions,portion_g,consistency,diet_tags,equipment,storage,shelf_life,photo_doc_id,sale_price,owner_user_id,created_at,updated_at)
      SELECT ?,org_id,unit_id,?,?,'draft',?,category,description,method,prep_minutes,yield_g,portions,portion_g,consistency,diet_tags,equipment,storage,shelf_life,photo_doc_id,sale_price,?,?,? FROM recipes WHERE id=?`)
      .bind(id, opts.newKey ? uid() : row.recipe_key, version, opts.name ?? row.name, a.userId, ts, ts, row.id),
    c.env.DB.prepare(`INSERT INTO recipe_items (id,org_id,recipe_id,food_id,gross_g,net_g,correction_factor,unit,notes,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),org_id,?,food_id,gross_g,net_g,correction_factor,unit,notes,?,? FROM recipe_items WHERE recipe_id=?`).bind(id, ts, ts, row.id)
  ])
  return id
}
recipes.post('/recipes/:id/versions', need('recipes.write'), async (c) => {
  const row = await loadRow(c, RES, c.req.param('id'), 'recipes.write')
  const id = await copyRecipe(c, row, { newKey: false })
  await audit(c, 'new_version', 'recipes', id, { from: row.id })
  return c.json(await full(c, await c.env.DB.prepare('SELECT * FROM recipes WHERE id=?').bind(id).first()), 201)
})
recipes.post('/recipes/:id/duplicate', need('recipes.write'), async (c) => {
  const row = await loadRow(c, RES, c.req.param('id'), 'recipes.write')
  const b = await readBody(c).catch(() => ({} as any))
  const id = await copyRecipe(c, row, { newKey: true, name: b.name ? String(b.name).slice(0, 200) : `${row.name} (cópia)` })
  await audit(c, 'duplicate', 'recipes', id, { from: row.id })
  return c.json(await full(c, await c.env.DB.prepare('SELECT * FROM recipes WHERE id=?').bind(id).first()), 201)
})

/** Substituição de ingrediente com comparação de custo/nutrição. preview:true não grava. Só em rascunho. */
recipes.post('/recipes/:id/substitute', need('recipes.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const row = await loadRow(c, RES, c.req.param('id'), 'recipes.write')
  const from = String(b.from_food_id ?? ''), to = String(b.to_food_id ?? '')
  if (!(await c.env.DB.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(to, a.orgId).first())) throw bad('invalid_reference', 'Alimento de destino inválido')
  if (!(await c.env.DB.prepare('SELECT 1 FROM recipe_items WHERE recipe_id=? AND food_id=?').bind(row.id, from).first())) throw bad('invalid_reference', 'Alimento de origem não está na receita')
  const before = await recipeCalc(c.env, a.orgId!, row.id)
  const after = await recipeCalc(c.env, a.orgId!, row.id, { from, to })
  if (!b.preview) {
    if (row.status !== 'draft') throw conflict('approved_immutable', 'Receita aprovada: crie uma nova versão antes de substituir')
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE recipe_items SET food_id=?, updated_at=? WHERE recipe_id=? AND food_id=?').bind(to, nowIso(), row.id, from),
      c.env.DB.prepare('UPDATE recipes SET nutrition_reviewed=0, allergens_reviewed=0, updated_at=? WHERE id=?').bind(nowIso(), row.id)
    ])
    await audit(c, 'substitute', 'recipes', row.id, { from, to })
  }
  return c.json({
    applied: !b.preview,
    cost_per_portion: { before: before!.cost_per_portion, after: after!.cost_per_portion, delta: round(after!.cost_per_portion - before!.cost_per_portion, 4) },
    nutrition_per_portion: { before: before!.nutrition_per_portion, after: after!.nutrition_per_portion },
    allergens: { before: before!.allergens, after: after!.allergens },
    cost_complete_after: after!.cost_complete
  })
})

recipes.delete('/recipes/:id', need('recipes.write'), async (c) => {
  const a = c.get('auth')
  const row = await loadRow(c, RES, c.req.param('id'), 'recipes.write')
  if (row.status !== 'draft') throw conflict('approved_immutable', 'Somente rascunhos podem ser excluídos')
  if (await c.env.DB.prepare('SELECT 1 FROM menu_items WHERE recipe_id=? LIMIT 1').bind(row.id).first()) throw conflict('recipe_in_use', 'Receita usada em cardápio')
  await c.env.DB.prepare('DELETE FROM recipes WHERE id=? AND org_id=?').bind(row.id, a.orgId).run()
  await audit(c, 'delete', 'recipes', row.id)
  return c.json({ ok: true })
})
export { forbidden }

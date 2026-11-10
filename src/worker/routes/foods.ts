import { Hono } from 'hono'
import { type AppEnv, audit, need } from '../lib/auth'
import { f, mountCrud } from '../lib/crud'
import { bad, conflict, forbidden, nowIso, notFound, num, parseJson, readBody, uid } from '../lib/util'

export const foods = new Hono<AppEnv>()

const KINDS = ['in_natura', 'processed', 'preparation', 'industrial', 'own', 'supplier']
const NUT = ['energy_kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sodium_mg'] as const

function foodOut(r: any) {
  return {
    id: r.id, scope: r.org_id ? 'organizacao' : 'base_global', name: r.name, category: r.category, kind: r.kind, description: r.description, unit: r.unit,
    gross_g: r.gross_g, net_g: r.net_g, correction_factor: r.correction_factor, cooking_factor: r.cooking_factor,
    energy_kcal: r.energy_kcal, protein_g: r.protein_g, carb_g: r.carb_g, fat_g: r.fat_g, fiber_g: r.fiber_g, sodium_mg: r.sodium_mg,
    micros: parseJson(r.micros, {}), allergens: parseJson(r.allergens, []), restrictions: parseJson(r.restrictions, []), tags: parseJson(r.tags, []),
    source: r.source, table_version: r.table_version, source_updated_at: r.source_updated_at, active: !!r.active, updated_at: r.updated_at,
    nutrition_basis: 'por 100 g do alimento (parte comestível)'
  }
}

function foodData(b: Record<string, any>, partial: boolean) {
  const d: Record<string, any> = {}
  const str = (k: string, max = 200) => { if (k in b) d[k] = b[k] == null ? null : String(b[k]).slice(0, max) }
  const numF = (k: string, min = 0) => {
    if (k in b) {
      if (b[k] === null || b[k] === '') { d[k] = null; return }
      const n = Number(b[k])
      if (!Number.isFinite(n) || n < min) throw bad('invalid_field', `Campo ${k} inválido`)
      d[k] = n
    }
  }
  str('name'); str('category', 80); str('description', 1000); str('unit', 10); str('table_version', 60); str('source', 200)
  if ('source_updated_at' in b) d.source_updated_at = b.source_updated_at
  if ('kind' in b) { if (!KINDS.includes(b.kind)) throw bad('invalid_field', `kind deve ser: ${KINDS.join(', ')}`); d.kind = b.kind }
  for (const k of ['gross_g', 'net_g', ...NUT]) numF(k)
  numF('correction_factor', 0.0001); numF('cooking_factor', 0.0001)
  for (const k of ['allergens', 'restrictions', 'tags']) if (k in b) { if (!Array.isArray(b[k])) throw bad('invalid_field', `${k} deve ser lista`); d[k] = JSON.stringify(b[k].map(String)) }
  if ('micros' in b) d.micros = JSON.stringify(b.micros ?? {})
  if ('active' in b) d.active = b.active ? 1 : 0
  if (!partial) {
    if (!d.name) throw bad('missing_field', 'Campo obrigatório: name')
    if (!d.source) throw bad('missing_field', 'Campo obrigatório: source (a origem dos dados deve ser registrada)')
  }
  return d
}

foods.get('/foods', need('foods.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const where = ['(org_id=? OR org_id IS NULL)'], params: unknown[] = [a.orgId]
  if (q.get('q')) { where.push('name LIKE ?'); params.push(`%${q.get('q')!.replace(/[%_]/g, '')}%`) }
  for (const k of ['category', 'kind', 'source']) if (q.get(k)) { where.push(`${k}=?`); params.push(q.get(k)) }
  if (q.get('active') !== 'all') where.push('active=1')
  const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 500), offset = Number(q.get('offset') ?? 0) || 0
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM foods WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<any>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM foods WHERE ${where.join(' AND ')}`).bind(...params).first<any>()
  ])
  return c.json({ items: rows.results.map(foodOut), total: total?.n ?? 0, limit, offset })
})
foods.get('/foods/:id', need('foods.read'), async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!r) throw notFound('Alimento')
  return c.json(foodOut(r))
})
foods.post('/foods', need('foods.write'), async (c) => {
  const a = c.get('auth')
  const d = foodData(await readBody(c), false)
  const id = uid(), ts = nowIso()
  const cols = ['id', 'org_id', 'created_by', 'created_at', 'updated_at', ...Object.keys(d)]
  await c.env.DB.prepare(`INSERT INTO foods (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(id, a.orgId, a.userId, ts, ts, ...Object.values(d)).run()
  await audit(c, 'create', 'foods', id, { source: d.source })
  return c.json(foodOut(await c.env.DB.prepare('SELECT * FROM foods WHERE id=?').bind(id).first()), 201)
})
foods.put('/foods/:id', need('foods.write'), async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('SELECT * FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(c.req.param('id'), a.orgId).first<any>()
  if (!r) throw notFound('Alimento')
  if (!r.org_id) throw forbidden('Itens da base global são somente leitura. Duplique para criar um alimento próprio.')
  const d = foodData(await readBody(c), true)
  const keys = Object.keys(d)
  if (keys.length) await c.env.DB.prepare(`UPDATE foods SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).bind(...Object.values(d), nowIso(), r.id).run()
  await audit(c, 'update', 'foods', r.id, { fields: keys })
  return c.json(foodOut(await c.env.DB.prepare('SELECT * FROM foods WHERE id=?').bind(r.id).first()))
})
foods.delete('/foods/:id', need('foods.write'), async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('SELECT * FROM foods WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!r) throw notFound('Alimento')
  if (await c.env.DB.prepare('SELECT 1 FROM recipe_items WHERE food_id=? LIMIT 1').bind(r.id).first()) throw conflict('food_in_use', 'Alimento usado em receitas. Desative-o em vez de excluir.')
  await c.env.DB.prepare('DELETE FROM foods WHERE id=?').bind(r.id).run()
  await audit(c, 'delete', 'foods', r.id)
  return c.json({ ok: true })
})
foods.post('/foods/:id/duplicate', need('foods.write'), async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('SELECT * FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(c.req.param('id'), a.orgId).first<any>()
  if (!r) throw notFound('Alimento')
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare(
    `INSERT INTO foods (id,org_id,name,category,kind,description,unit,gross_g,net_g,correction_factor,cooking_factor,energy_kcal,protein_g,carb_g,fat_g,fiber_g,sodium_mg,micros,allergens,restrictions,tags,source,table_version,source_updated_at,created_by,created_at,updated_at)
     SELECT ?,?,name||' (cópia)',category,'own',description,unit,gross_g,net_g,correction_factor,cooking_factor,energy_kcal,protein_g,carb_g,fat_g,fiber_g,sodium_mg,micros,allergens,restrictions,tags,source,table_version,source_updated_at,?,?,? FROM foods WHERE id=?`
  ).bind(id, a.orgId, a.userId, ts, ts, r.id).run()
  await audit(c, 'create', 'foods', id, { duplicated_from: r.id })
  return c.json(foodOut(await c.env.DB.prepare('SELECT * FROM foods WHERE id=?').bind(id).first()), 201)
})

/** Importação de tabelas (TACO/TBCA/USDA etc.). O usuário fornece o CSV e responde pela licença; origem e versão são obrigatórias. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cur = '', q = false
  const sep = text.split('\n', 1)[0].includes(';') ? ';' : ','
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += ch
    } else if (ch === '"') q = true
    else if (ch === sep) { row.push(cur); cur = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = [] }
    else cur += ch
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((x) => x !== '')) rows.push(row) }
  return rows
}
foods.post('/foods/import', need('foods.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const source = String(b.source ?? '').trim(), version = String(b.table_version ?? '').trim()
  if (!source || !version) throw bad('missing_field', 'Informe source e table_version (a origem dos dados é obrigatória)')
  if (b.license_confirmed !== true) throw bad('license_required', 'Confirme (license_confirmed:true) que você tem direito de uso/licença dos dados importados')
  const rows = parseCsv(String(b.csv ?? ''))
  if (rows.length < 2) throw bad('empty_csv', 'CSV vazio')
  if (rows.length > 2001) throw bad('too_many_rows', 'Máximo de 2000 linhas por importação')
  const head = rows[0].map((h) => h.trim().toLowerCase())
  if (!head.includes('name')) throw bad('invalid_csv', 'Coluna obrigatória: name')
  const ts = nowIso(), stmts: D1PreparedStatement[] = []
  let skipped = 0
  for (const r of rows.slice(1)) {
    const o: Record<string, string> = {}
    head.forEach((h, i) => (o[h] = (r[i] ?? '').trim()))
    if (!o.name) { skipped++; continue }
    const n = (k: string) => (o[k] === undefined || o[k] === '' ? null : Number(String(o[k]).replace(',', '.')))
    const vals = NUT.map(n)
    if (vals.some((v) => v !== null && !Number.isFinite(v))) { skipped++; continue }
    const list = (k: string) => JSON.stringify((o[k] ?? '').split('|').map((x) => x.trim()).filter(Boolean))
    stmts.push(c.env.DB.prepare(
      `INSERT INTO foods (id,org_id,name,category,kind,energy_kcal,protein_g,carb_g,fat_g,fiber_g,sodium_mg,allergens,tags,source,table_version,source_updated_at,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(uid(), a.orgId, o.name.slice(0, 200), o.category || null, KINDS.includes(o.kind) ? o.kind : 'in_natura', ...vals, list('allergens'), list('tags'), source, version, b.source_updated_at ?? null, a.userId, ts, ts))
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50))
  await audit(c, 'import', 'foods', undefined, { imported: stmts.length, skipped, source, version })
  return c.json({ imported: stmts.length, skipped }, 201)
})

mountCrud(foods, {
  table: 'suppliers', path: 'suppliers', read: 'suppliers.read', write: 'suppliers.write', unit: false, order: 'name ASC', search: ['name'],
  fields: [f.s('name', { req: true, max: 160 }), f.s('tax_id', { max: 30 }), f.s('contact', { max: 300 }), f.b('active')]
})

// ---------- preços (fonte obrigatória; nunca inventados) ----------
foods.get('/prices', need('foods.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const where = ['p.org_id=?'], params: unknown[] = [a.orgId]
  if (q.get('food_id')) { where.push('p.food_id=?'); params.push(q.get('food_id')) }
  const r = await c.env.DB.prepare(`SELECT p.*,f.name AS food_name FROM food_prices p JOIN foods f ON f.id=p.food_id WHERE ${where.join(' AND ')} ORDER BY p.valid_from DESC, p.created_at DESC LIMIT 500`).bind(...params).all()
  return c.json({ items: r.results })
})
foods.post('/prices', need('prices.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const price = Number(b.price_per_kg)
  if (!Number.isFinite(price) || price < 0) throw bad('invalid_field', 'price_per_kg inválido')
  if (!String(b.source ?? '').trim()) throw bad('missing_field', 'Informe a fonte do preço (source)')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_from ?? ''))) throw bad('invalid_field', 'valid_from deve ser YYYY-MM-DD')
  if (!(await c.env.DB.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(String(b.food_id ?? ''), a.orgId).first())) throw bad('invalid_reference', 'Alimento inválido')
  if (b.supplier_id && !(await c.env.DB.prepare('SELECT 1 FROM suppliers WHERE id=? AND org_id=?').bind(String(b.supplier_id), a.orgId).first())) throw bad('invalid_reference', 'Fornecedor inválido')
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO food_prices (id,org_id,food_id,supplier_id,price_per_kg,source,valid_from,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, b.food_id, b.supplier_id ?? null, price, String(b.source).slice(0, 200), b.valid_from, a.userId, ts, ts).run()
  await audit(c, 'create', 'food_prices', id, { food_id: b.food_id })
  return c.json({ id }, 201)
})
foods.post('/prices/import', need('prices.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const source = String(b.source ?? '').trim()
  if (!source) throw bad('missing_field', 'Informe a fonte dos preços (source)')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_from ?? ''))) throw bad('invalid_field', 'valid_from deve ser YYYY-MM-DD')
  const rows = parseCsv(String(b.csv ?? ''))
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  if (!head.includes('food_name') || !head.includes('price_per_kg')) throw bad('invalid_csv', 'Colunas: food_name, price_per_kg')
  const ts = nowIso(), stmts: D1PreparedStatement[] = [], notFoundNames: string[] = []
  for (const r of rows.slice(1, 2001)) {
    const name = (r[head.indexOf('food_name')] ?? '').trim()
    const price = Number((r[head.indexOf('price_per_kg')] ?? '').replace(',', '.'))
    if (!name || !Number.isFinite(price) || price < 0) continue
    const fd = await c.env.DB.prepare('SELECT id FROM foods WHERE name=? AND (org_id=? OR org_id IS NULL) ORDER BY org_id DESC LIMIT 1').bind(name, a.orgId).first<any>()
    if (!fd) { notFoundNames.push(name); continue }
    stmts.push(c.env.DB.prepare('INSERT INTO food_prices (id,org_id,food_id,price_per_kg,source,valid_from,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(uid(), a.orgId, fd.id, price, source, b.valid_from, a.userId, ts, ts))
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50))
  await audit(c, 'import', 'food_prices', undefined, { imported: stmts.length, source })
  return c.json({ imported: stmts.length, not_found: notFoundNames.slice(0, 50) }, 201)
})

mountCrud(foods, {
  table: 'budget_profiles', path: 'budget-profiles', read: 'recipes.read', write: 'budget.manage', unit: false, order: 'name ASC',
  fields: [f.s('key', { req: true, max: 40 }), f.s('name', { req: true, max: 80 }), f.s('description', { max: 500 }), f.j('rules'),
    f.r('limit_per_patient'), f.r('limit_per_day'), f.r('limit_per_meal'), f.r('limit_per_portion'), f.r('limit_per_menu'), f.r('limit_per_guest'), f.r('limit_per_event'), f.r('limit_per_unit')]
})
export { num }

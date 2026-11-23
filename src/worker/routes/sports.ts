import { Hono } from 'hono'
import { type AppCtx, type AppEnv, audit, can, need, needAny, unitScope } from '../lib/auth'
import { f, mountCrud, loadRow, type Res, serializeRow } from '../lib/crud'
import { guardSubject, mountSubjectCrud } from '../lib/subject'
import { recipeCalc, NUTRIENTS, type Totals } from '../lib/calc'
import { decryptValue } from '../lib/crypto'
import { buildPdf, pdfResponse, responsibleLine } from '../lib/pdf'
import { bad, conflict, nowIso, norm, notFound, num, parseJson, readBody, round, today, uid } from '../lib/util'

export const sports = new Hono<AppEnv>()

const ATHLETE: Res = {
  table: 'athletes', path: 'athletes', read: 'sports.read', write: 'sports.write', unit: 'loose', order: 'name ASC', auditRead: true,
  filters: ['sport', 'active'], search: ['name', 'sport'],
  fields: [
    f.s('name', { req: true, max: 160 }), f.d('birth_date'), f.s('sex', { max: 20 }), f.r('height_cm'), f.r('weight_kg'), f.s('sport', { max: 80 }),
    f.s('category', { max: 80 }), f.s('position', { max: 80 }), f.i('training_freq_week'), f.i('training_minutes'), f.s('intensity', { max: 40 }),
    f.s('goals', { max: 2000 }), f.r('sleep_hours'), f.r('hydration_ml'), f.j('clinical_history', { enc: true }), f.j('medications', { enc: true }),
    f.j('allergies', { enc: true }), f.j('restrictions', { enc: true }), f.b('active'), f.s('user_id', { ref: 'users', max: 64 })
  ]
}
mountCrud(sports, ATHLETE)

mountSubjectCrud(sports, {
  table: 'assessments', path: 'assessments', read: 'sports.read', write: 'sports.write', order: 'date DESC', auditRead: true,
  fields: [f.d('date', { req: true }), f.r('weight_kg'), f.r('height_cm'), f.j('circumferences'), f.j('skinfolds'), f.r('body_fat_pct'), f.r('lean_mass_kg'),
    f.r('recovery_score'), f.r('fatigue_score'), f.j('performance'), f.s('notes', { enc: true, max: 4000 })]
})
sports.get('/assessments-compare', needAny('sports.read', 'clinical.read'), async (c) => {
  const q = new URL(c.req.url).searchParams
  const a = c.get('auth')
  const rows: any[] = []
  for (const id of [q.get('a'), q.get('b')]) {
    const r = await c.env.DB.prepare('SELECT * FROM assessments WHERE id=? AND org_id=?').bind(id ?? '', a.orgId).first<any>()
    if (!r) throw notFound('Avaliação')
    await guardSubject(c, r.subject_type, r.subject_id, 'read')
    rows.push(r)
  }
  if (rows[0].subject_id !== rows[1].subject_id) throw bad('different_subjects', 'As avaliações devem ser da mesma pessoa')
  const [x, y] = rows.sort((p, q2) => p.date.localeCompare(q2.date)) // x = anterior, y = posterior
  const diff: Record<string, { from: number | null; to: number | null; delta: number | null }> = {}
  const add = (k: string, p: any, q2: any) => {
    const from = p == null ? null : Number(p), to = q2 == null ? null : Number(q2)
    diff[k] = { from, to, delta: from != null && to != null ? round(to - from, 2) : null }
  }
  for (const k of ['weight_kg', 'height_cm', 'body_fat_pct', 'lean_mass_kg', 'recovery_score', 'fatigue_score']) add(k, x[k], y[k])
  for (const grp of ['circumferences', 'skinfolds']) {
    const p = parseJson<Record<string, number>>(x[grp], {}), q2 = parseJson<Record<string, number>>(y[grp], {})
    for (const k of new Set([...Object.keys(p), ...Object.keys(q2)])) add(`${grp}.${k}`, p[k], q2[k])
  }
  return c.json({ from_date: x.date, to_date: y.date, days: Math.round((Date.parse(y.date) - Date.parse(x.date)) / 86400000), diff })
})

mountCrud(sports, {
  table: 'training_sessions', path: 'training-sessions', read: 'sports.read', write: 'sports.write', unit: 'loose', order: 'date DESC', filters: ['athlete_id'],
  fields: [f.s('athlete_id', { req: true, ref: 'athletes', max: 64 }), f.d('date', { req: true }), f.s('kind', { max: 80 }), f.i('duration_min'), f.r('rpe'), f.s('notes', { max: 2000 })],
  hooks: { async beforeWrite(c, data) { await inheritUnit(c, data) } }
})
mountCrud(sports, {
  table: 'competitions', path: 'competitions', read: 'sports.read', write: 'sports.write', unit: 'loose', order: 'date ASC', filters: ['athlete_id'],
  fields: [f.s('athlete_id', { req: true, ref: 'athletes', max: 64 }), f.s('name', { req: true, max: 160 }), f.d('date', { req: true }), f.s('location', { max: 160 }), f.s('notes', { max: 2000 })],
  hooks: { async beforeWrite(c, data) { await inheritUnit(c, data) } }
})
async function inheritUnit(c: AppCtx, data: Record<string, any>) {
  if (data.athlete_id) {
    const at = await c.env.DB.prepare('SELECT unit_id FROM athletes WHERE id=? AND org_id=?').bind(data.athlete_id, c.get('auth').orgId).first<any>()
    data.unit_id = at?.unit_id ?? null
  }
}

mountSubjectCrud(sports, {
  table: 'goals', path: 'goals', read: 'sports.read', write: 'sports.write', order: 'created_at DESC',
  fields: [f.s('metric', { req: true, max: 80 }), f.r('target'), f.r('current'), f.r('start_value'), f.d('due_date'), f.s('status', { enum: ['open', 'achieved', 'abandoned'] }), f.s('notes', { max: 1000 })]
})
sports.get('/goals-progress', needAny('sports.read', 'clinical.read'), async (c) => {
  const q = new URL(c.req.url).searchParams
  const s = await guardSubject(c, q.get('subject_type'), q.get('subject_id'), 'read')
  const rows = (await c.env.DB.prepare('SELECT * FROM goals WHERE org_id=? AND subject_type=? AND subject_id=?').bind(c.get('auth').orgId, s.type, s.id).all<any>()).results
  return c.json({
    items: rows.map((g) => {
      let pct: number | null = null
      if (g.target != null && g.start_value != null && g.current != null && g.target !== g.start_value) pct = round(((g.current - g.start_value) / (g.target - g.start_value)) * 100, 1)
      return { id: g.id, metric: g.metric, start_value: g.start_value, current: g.current, target: g.target, status: g.status, progress_pct: pct, due_date: g.due_date }
    })
  })
})

// ---------- suplementação ----------
mountCrud(sports, {
  table: 'substance_rules', path: 'substance-rules', read: 'sports.read', write: 'sports.supplements', unit: false, order: 'name ASC',
  fields: [f.s('name', { req: true, max: 160 }), f.s('sport', { max: 80 }), f.s('severity', { enum: ['info', 'warning', 'prohibited'] }), f.s('source', { req: true, max: 300 }), f.s('notes', { max: 1000 })]
})
async function substanceWarnings(c: AppCtx, subject: any, product: string, ingredient: string) {
  const a = c.get('auth')
  const rules = (await c.env.DB.prepare('SELECT * FROM substance_rules WHERE org_id=?').bind(a.orgId).all<any>()).results
  const text = norm(`${product} ${ingredient}`)
  const sport = subject.row.sport ? norm(subject.row.sport) : null
  const warnings: any[] = []
  for (const r of rules) {
    if (r.sport && sport && norm(r.sport) !== sport) continue
    if (r.sport && !sport) continue
    if (text.includes(norm(r.name))) warnings.push({ type: 'regra_configurada', severity: r.severity, name: r.name, source: r.source, notes: r.notes })
  }
  const meds = subject.type === 'athlete' ? await decryptValue<any[]>(c.env, subject.row.medications, `athletes.medications.${subject.id}`) : null
  if (meds && meds.length) warnings.push({ type: 'medicamentos_informados', severity: 'info', message: `Verifique possíveis interações com os medicamentos informados: ${meds.map(String).join(', ')}. O sistema não avalia interações automaticamente.` })
  return warnings
}
mountSubjectCrud(sports, {
  table: 'supplements', path: 'supplements', read: 'sports.read', write: 'sports.supplements', order: 'created_at DESC', auditRead: true,
  fields: [f.s('product', { req: true, max: 200 }), f.s('ingredient', { req: true, max: 200 }), f.s('dose', { req: true, max: 200 }), f.s('dose_time', { max: 80 }), f.s('objective', { max: 300 }),
    f.d('start_date'), f.d('end_date'), f.s('notes', { max: 1000 }), f.s('override_reason', { max: 500 }), f.j('warnings', { ro: true })]
}, {
  async beforeWrite(c, data, subject, existing) {
    const product = data.product ?? existing?.product, ingredient = data.ingredient ?? existing?.ingredient
    const w = await substanceWarnings(c, subject, product, ingredient)
    const blocked = w.filter((x) => x.severity === 'prohibited')
    const reason = data.override_reason ?? existing?.override_reason
    if (blocked.length && (!reason || String(reason).trim().length < 10)) {
      throw conflict('prohibited_substance', 'Substância marcada como proibida nas regras antidopagem configuradas. Para prescrever, informe override_reason (justificativa profissional, mín. 10 caracteres).', w)
    }
    ;(data as any).warnings = w
    ;(data as any).prescribed_by = c.get('auth').userId
  }
})

// ---------- planos alimentares (atleta e paciente) ----------
const PLAN_PERM = { athlete: { read: 'sports.read', write: 'sports.write', approve: 'sports.approve' }, patient: { read: 'clinical.read', write: 'clinical.write', approve: 'hospital.prescribe' } }
async function allergyList(c: AppCtx, subject: any): Promise<string[]> {
  const col = subject.type === 'athlete' ? 'athletes' : 'patients'
  const v = await decryptValue<any>(c.env, subject.row.allergies, `${col}.allergies.${subject.id}`)
  return (Array.isArray(v) ? v : v ? [v] : []).map((x: any) => norm(String(x)))
}
async function planView(c: AppCtx, plan: any, subject: any) {
  const a = c.get('auth')
  const items = (await c.env.DB.prepare('SELECT * FROM meal_plan_items WHERE plan_id=? AND org_id=? ORDER BY meal_time, created_at').bind(plan.id, a.orgId).all<any>()).results
  const allergies = await allergyList(c, subject)
  const total: Totals = { energy_kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: 0, sodium_mg: 0 }
  const outItems: any[] = [], conflicts: any[] = []
  for (const it of items) {
    let per100: Partial<Totals> | null = null, name = '', alg: string[] = []
    if (it.food_id) {
      const fd = await c.env.DB.prepare('SELECT * FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(it.food_id, a.orgId).first<any>()
      if (fd) { name = fd.name; per100 = Object.fromEntries(NUTRIENTS.map((n) => [n, fd[n]])) as any; alg = parseJson<string[]>(fd.allergens, []).map(norm) }
    } else if (it.recipe_id) {
      const rc = await recipeCalc(c.env, a.orgId!, it.recipe_id)
      const rr = await c.env.DB.prepare('SELECT name FROM recipes WHERE id=?').bind(it.recipe_id).first<any>()
      if (rc) { name = rr?.name ?? ''; per100 = rc.nutrition_per_100g; alg = rc.allergens }
    }
    const nutr: Partial<Totals> = {}
    for (const n of NUTRIENTS) if (per100 && per100[n] != null) { nutr[n] = round((num(per100[n]) * num(it.qty_g)) / 100, 2); total[n] += nutr[n]! }
    for (const al of alg) if (allergies.some((x) => x && (al.includes(x) || x.includes(al)))) conflicts.push({ item_id: it.id, item: name, allergen: al, level: 'critical' })
    outItems.push({ id: it.id, meal_name: it.meal_name, meal_time: it.meal_time, food_id: it.food_id, recipe_id: it.recipe_id, name, qty_g: it.qty_g, notes: it.notes, nutrients: nutr })
  }
  for (const n of NUTRIENTS) total[n] = round(total[n], 2)
  return {
    id: plan.id, subject_type: plan.subject_type, subject_id: plan.subject_id, name: plan.name, status: plan.status, valid_from: plan.valid_from, valid_to: plan.valid_to,
    strategies: parseJson(plan.strategies, {}), periodization: parseJson(plan.periodization, []), notes: plan.notes, approved_by: plan.approved_by, approved_at: plan.approved_at,
    items: outItems, nutrition_total: total, allergy_conflicts: conflicts, created_at: plan.created_at
  }
}
async function planItems(c: AppCtx, items: unknown) {
  if (!Array.isArray(items)) return []
  const a = c.get('auth'), out: any[] = []
  for (const it of items.slice(0, 200)) {
    if (!it?.meal_name) throw bad('invalid_item', 'Cada item exige meal_name')
    if (it.food_id && !(await c.env.DB.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(String(it.food_id), a.orgId).first())) throw bad('invalid_reference', 'Alimento inválido')
    if (it.recipe_id && !(await c.env.DB.prepare('SELECT 1 FROM recipes WHERE id=? AND org_id=?').bind(String(it.recipe_id), a.orgId).first())) throw bad('invalid_reference', 'Receita inválida')
    const q = Number(it.qty_g ?? 0)
    if (!Number.isFinite(q) || q < 0) throw bad('invalid_item', 'qty_g inválido')
    out.push({ meal_name: String(it.meal_name).slice(0, 80), meal_time: it.meal_time ? String(it.meal_time).slice(0, 10) : null, food_id: it.food_id ?? null, recipe_id: it.recipe_id ?? null, qty_g: q, notes: it.notes ? String(it.notes).slice(0, 300) : null })
  }
  return out
}
const planStmts = (c: AppCtx, planId: string, items: any[]) => {
  const ts = nowIso(), a = c.get('auth')
  return items.map((i) => c.env.DB.prepare('INSERT INTO meal_plan_items (id,org_id,plan_id,meal_name,meal_time,food_id,recipe_id,qty_g,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(uid(), a.orgId, planId, i.meal_name, i.meal_time, i.food_id, i.recipe_id, i.qty_g, i.notes, ts, ts))
}
sports.get('/meal-plans', needAny('sports.read', 'clinical.read'), async (c) => {
  const q = new URL(c.req.url).searchParams
  const s = await guardSubject(c, q.get('subject_type'), q.get('subject_id'), 'read')
  const rows = (await c.env.DB.prepare('SELECT * FROM meal_plans WHERE org_id=? AND subject_type=? AND subject_id=? ORDER BY created_at DESC').bind(c.get('auth').orgId, s.type, s.id).all<any>()).results
  return c.json({ items: rows.map((p) => ({ id: p.id, name: p.name, status: p.status, valid_from: p.valid_from, valid_to: p.valid_to, approved_at: p.approved_at, created_at: p.created_at })) })
})
sports.get('/meal-plans/:id', needAny('sports.read', 'clinical.read'), async (c) => {
  const p = await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!p) throw notFound('Plano')
  const s = await guardSubject(c, p.subject_type, p.subject_id, 'read')
  await audit(c, 'read', 'meal_plans', p.id)
  return c.json(await planView(c, p, s))
})
sports.get('/meal-plans/:id/export.pdf', needAny('sports.read', 'clinical.read'), async (c) => {
  const p = await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!p) throw notFound('Plano')
  const s = await guardSubject(c, p.subject_type, p.subject_id, 'read')
  const v = await planView(c, p, s)
  const k = (x: unknown) => (x == null ? '-' : Number(x).toLocaleString('pt-BR', { maximumFractionDigits: 1 }))
  const t = v.nutrition_total as any
  const bytes = await buildPdf({ title: `Plano alimentar: ${v.name}`, subtitle: `${v.status === 'approved' ? 'APROVADO' : 'RASCUNHO - não aprovado'}${v.valid_from ? ' - vigência desde ' + v.valid_from : ''}`,
    blocks: [
      ...(v.allergy_conflicts.length ? [{ t: 'alert' as const, text: 'CONFLITO DE ALERGIA: ' + v.allergy_conflicts.map((x: any) => `${x.item} (${x.allergen})`).join('; ') }] : []),
      { t: 'table', head: ['Refeição', 'Horário', 'Item', 'Qtd (g)', 'kcal', 'Prot (g)', 'Carb (g)', 'Gord (g)'], widths: [2, 1, 3.5, 1, 1, 1, 1, 1], rows: v.items.map((i: any) => [i.meal_name, i.meal_time ?? '', i.name, k(i.qty_g), k(i.nutrients.energy_kcal), k(i.nutrients.protein_g), k(i.nutrients.carb_g), k(i.nutrients.fat_g)]) },
      { t: 'kv', rows: [['Total (só dados com fonte)', `${k(t.energy_kcal)} kcal | P ${k(t.protein_g)} g | C ${k(t.carb_g)} g | G ${k(t.fat_g)} g`]] },
      ...(v.notes ? [{ t: 'p' as const, text: String(v.notes) }] : []),
      { t: 'p' as const, text: await responsibleLine(c.env.DB, c.get('auth').orgId!, v.approved_by) }
    ] })
  await audit(c, 'export', 'meal_plans', p.id, { format: 'pdf' })
  return pdfResponse(bytes, `plano-${p.id.slice(0, 8)}.pdf`)
})
sports.post('/meal-plans', needAny('sports.write', 'clinical.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const s = await guardSubject(c, b.subject_type, b.subject_id, 'write')
  if (!String(b.name ?? '').trim()) throw bad('missing_field', 'Informe name')
  const items = await planItems(c, b.items)
  const id = uid(), ts = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO meal_plans (id,org_id,unit_id,subject_type,subject_id,name,status,valid_from,valid_to,strategies,periodization,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, a.orgId, s.unit_id, s.type, s.id, String(b.name).slice(0, 160), 'draft', b.valid_from ?? null, b.valid_to ?? null, JSON.stringify(b.strategies ?? {}), JSON.stringify(b.periodization ?? []), b.notes ? String(b.notes).slice(0, 4000) : null, a.userId, ts, ts),
    ...planStmts(c, id, items)
  ])
  await audit(c, 'create', 'meal_plans', id, { items: items.length, subject_type: s.type })
  return c.json(await planView(c, await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=?').bind(id).first(), s), 201)
})
sports.put('/meal-plans/:id', needAny('sports.write', 'clinical.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const p = await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!p) throw notFound('Plano')
  const s = await guardSubject(c, p.subject_type, p.subject_id, 'write')
  if (p.status !== 'draft') throw conflict('approved_immutable', 'Plano aprovado não pode ser alterado. Crie uma revisão (POST /meal-plans/:id/revise).')
  const stmts: D1PreparedStatement[] = [c.env.DB.prepare('UPDATE meal_plans SET name=?,valid_from=?,valid_to=?,strategies=?,periodization=?,notes=?,updated_at=? WHERE id=?')
    .bind(b.name ?? p.name, 'valid_from' in b ? b.valid_from : p.valid_from, 'valid_to' in b ? b.valid_to : p.valid_to, b.strategies ? JSON.stringify(b.strategies) : p.strategies, b.periodization ? JSON.stringify(b.periodization) : p.periodization, 'notes' in b ? b.notes : p.notes, nowIso(), p.id)]
  if (b.items !== undefined) stmts.push(c.env.DB.prepare('DELETE FROM meal_plan_items WHERE plan_id=?').bind(p.id), ...planStmts(c, p.id, await planItems(c, b.items)))
  await c.env.DB.batch(stmts)
  await audit(c, 'update', 'meal_plans', p.id, { items_replaced: b.items !== undefined })
  return c.json(await planView(c, await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=?').bind(p.id).first(), s))
})
sports.post('/meal-plans/:id/approve', needAny('sports.approve', 'hospital.prescribe'), async (c) => {
  const a = c.get('auth')
  const p = await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!p) throw notFound('Plano')
  const s = await guardSubject(c, p.subject_type, p.subject_id, 'write')
  const perm = (PLAN_PERM as any)[p.subject_type].approve
  if (!can(a, perm, s.unit_id)) throw notFound('Plano')
  if (p.status !== 'draft') throw conflict('invalid_state', 'Somente rascunhos podem ser aprovados')
  const view = await planView(c, p, s)
  if (view.items.length === 0) throw bad('no_items', 'Plano sem itens')
  if (view.allergy_conflicts.length) throw conflict('allergy_conflict', 'O plano contém itens que conflitam com alergias registradas. Substitua os itens antes de aprovar.', view.allergy_conflicts)
  const ts = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE meal_plans SET status='superseded', updated_at=? WHERE org_id=? AND subject_type=? AND subject_id=? AND status='approved'").bind(ts, a.orgId, p.subject_type, p.subject_id),
    c.env.DB.prepare("UPDATE meal_plans SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?").bind(a.userId, ts, ts, p.id)
  ])
  await audit(c, 'approve', 'meal_plans', p.id)
  return c.json({ ok: true })
})
sports.post('/meal-plans/:id/revise', needAny('sports.write', 'clinical.write'), async (c) => {
  const a = c.get('auth')
  const p = await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!p) throw notFound('Plano')
  const s = await guardSubject(c, p.subject_type, p.subject_id, 'write')
  const id = uid(), ts = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO meal_plans (id,org_id,unit_id,subject_type,subject_id,name,status,valid_from,valid_to,strategies,periodization,notes,created_by,created_at,updated_at) SELECT ?,org_id,unit_id,subject_type,subject_id,name||' (revisão)','draft',valid_from,valid_to,strategies,periodization,notes,?,?,? FROM meal_plans WHERE id=?").bind(id, a.userId, ts, ts, p.id),
    c.env.DB.prepare('INSERT INTO meal_plan_items (id,org_id,plan_id,meal_name,meal_time,food_id,recipe_id,qty_g,notes,created_at,updated_at) SELECT lower(hex(randomblob(16))),org_id,?,meal_name,meal_time,food_id,recipe_id,qty_g,notes,?,? FROM meal_plan_items WHERE plan_id=?').bind(id, ts, ts, p.id)
  ])
  await audit(c, 'revise', 'meal_plans', id, { from: p.id })
  return c.json(await planView(c, await c.env.DB.prepare('SELECT * FROM meal_plans WHERE id=?').bind(id).first(), s), 201)
})

// ---------- diário alimentar (profissional lê; o portal grava) ----------
mountSubjectCrud(sports, {
  table: 'food_diary', path: 'food-diary', read: 'sports.read', write: 'sports.write', order: 'date DESC', auditRead: true,
  fields: [f.d('date', { req: true }), f.s('meal_name', { req: true, max: 80 }), f.s('description', { req: true, max: 1000 })]
})

// ---------- painel esportivo (dados reais) ----------
sports.get('/dashboard/sports', need('sports.read'), async (c) => {
  const a = c.get('auth'), db = c.env.DB
  const scope = unitScope(a, 'sports.read')
  const uf = scope === null ? '' : `AND (unit_id IN (${scope.map(() => '?').join(',') || "''"}) OR unit_id IS NULL)`
  const up = scope === null ? [] : scope
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const d7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const t = today(), in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  const one = async (sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(a.orgId, ...up, ...p).first<any>())?.n ?? 0
  const activeAthletes = await one(`SELECT COUNT(*) AS n FROM athletes WHERE org_id=? ${uf} AND active=1`)
  const assessments30 = await one(`SELECT COUNT(*) AS n FROM assessments WHERE org_id=? ${uf} AND subject_type='athlete' AND date>=?`, d30)
  const consults30 = await one(`SELECT COUNT(*) AS n FROM events WHERE org_id=? ${uf} AND kind='consulta' AND starts_at>=?`, d30)
  const trainings30 = await one(`SELECT COUNT(*) AS n FROM training_sessions WHERE org_id=? ${uf} AND date>=?`, d30)
  const comps = (await db.prepare(`SELECT c.id,c.name,c.date,c.athlete_id,a.name AS athlete FROM competitions c JOIN athletes a ON a.id=c.athlete_id WHERE c.org_id=? ${uf.replace(/unit_id/g, 'c.unit_id')} AND c.date>=? AND c.date<=? ORDER BY c.date`).bind(a.orgId, ...up, t, in30).all()).results
  const goals = (await db.prepare(`SELECT status,COUNT(*) AS n FROM goals WHERE org_id=? ${uf} AND subject_type='athlete' GROUP BY status`).bind(a.orgId, ...up).all<any>()).results
  const withPlan = await one(`SELECT COUNT(DISTINCT subject_id) AS n FROM meal_plans WHERE org_id=? ${uf} AND subject_type='athlete' AND status='approved'`)
  const diaryAthletes = await one(`SELECT COUNT(DISTINCT subject_id) AS n FROM food_diary WHERE org_id=? ${uf} AND subject_type='athlete' AND date>=?`, d7)
  const evo = (await db.prepare(
    `SELECT subject_id,
      (SELECT weight_kg FROM assessments x WHERE x.subject_id=a.subject_id AND x.weight_kg IS NOT NULL ORDER BY date ASC LIMIT 1) AS first_w,
      (SELECT weight_kg FROM assessments x WHERE x.subject_id=a.subject_id AND x.weight_kg IS NOT NULL ORDER BY date DESC LIMIT 1) AS last_w
     FROM (SELECT DISTINCT subject_id FROM assessments WHERE org_id=? ${uf} AND subject_type='athlete') a`).bind(a.orgId, ...up).all<any>()).results
  const deltas = evo.filter((e) => e.first_w != null && e.last_w != null && e.first_w !== e.last_w).map((e) => e.last_w - e.first_w)
  return c.json({
    active_athletes: activeAthletes, assessments_last_30d: assessments30, consultations_last_30d: consults30, trainings_last_30d: trainings30,
    upcoming_competitions: comps, goals_by_status: Object.fromEntries(goals.map((g) => [g.status, g.n])),
    plan_adherence: { athletes_with_approved_plan: withPlan, athletes_with_diary_last_7d: diaryAthletes, note: 'Adesão = atletas com registro no diário nos últimos 7 dias entre os que têm plano aprovado' },
    adherence_pct: withPlan > 0 ? round((Math.min(diaryAthletes, withPlan) / withPlan) * 100, 1) : null,
    avg_weight_change_kg: deltas.length ? round(deltas.reduce((s, x) => s + x, 0) / deltas.length, 2) : null
  })
})
export { loadRow, serializeRow }

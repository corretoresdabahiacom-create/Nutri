import { Hono } from 'hono'
import { type AppCtx, type AppEnv, assertCan, audit, can, need, needAny, unitScope } from '../lib/auth'
import { f, mountCrud } from '../lib/crud'
import { guardSubject } from '../lib/subject'
import { recipeCalc } from '../lib/calc'
import { decryptValue } from '../lib/crypto'
import { bad, conflict, nowIso, norm, notFound, parseJson, readBody, today, uid } from '../lib/util'

export const hospital = new Hono<AppEnv>()

const CONSISTENCIES = ['normal', 'branda', 'pastosa', 'liquida', 'liquida_espessada', 'triturada'] as const
const ROUTES = ['oral', 'enteral', 'parenteral'] as const
const MEALS = ['cafe', 'colacao', 'almoco', 'lanche', 'jantar', 'ceia'] as const

// ---------- estrutura física ----------
for (const [table, path] of [['sectors', 'sectors'], ['wards', 'wards'], ['rooms', 'rooms']] as const) {
  mountCrud(hospital, {
    table, path, read: 'hospital.read', write: 'hospital.manage', unit: 'strict', unitReq: true, order: 'name ASC', filters: ['unit_id'],
    fields: [f.s('name', { req: true, max: 120 }), ...(table === 'wards' ? [f.s('sector_id', { ref: 'sectors', max: 64 })] : table === 'rooms' ? [f.s('ward_id', { ref: 'wards', max: 64 })] : [])]
  })
}
mountCrud(hospital, {
  table: 'beds', path: 'beds', read: 'hospital.read', write: 'hospital.manage', unit: 'strict', unitReq: true, order: 'code ASC', filters: ['unit_id', 'status'],
  fields: [f.s('code', { req: true, max: 40 }), f.s('sector_id', { ref: 'sectors', max: 64 }), f.s('ward_id', { ref: 'wards', max: 64 }), f.s('room_id', { ref: 'rooms', max: 64 }),
    f.s('status', { enum: ['free', 'blocked', 'cleaning'] })],
  hooks: {
    async beforeDelete(c, row) {
      if (await c.env.DB.prepare("SELECT 1 FROM patients WHERE bed_id=? AND status='admitted'").bind(row.id).first()) throw conflict('bed_in_use', 'Leito ocupado por paciente')
    }
  }
})

// ---------- pacientes ----------
async function syncBeds(c: AppCtx, row: any, existing: any | null) {
  const db = c.env.DB, ts = nowIso()
  if (existing?.bed_id && (existing.bed_id !== row.bed_id || row.status !== 'admitted')) {
    await db.prepare("UPDATE beds SET status='free', updated_at=? WHERE id=? AND status='occupied'").bind(ts, existing.bed_id).run()
  }
  if (row.bed_id && row.status === 'admitted') await db.prepare("UPDATE beds SET status='occupied', updated_at=? WHERE id=?").bind(ts, row.bed_id).run()
}
mountCrud(hospital, {
  table: 'patients', path: 'patients', read: 'clinical.read', write: 'clinical.write', unit: 'strict', unitReq: true, order: 'name ASC', auditRead: true,
  filters: ['unit_id', 'status'], search: ['name', 'internal_code'],
  fields: [
    f.s('internal_code', { req: true, max: 40 }), f.s('name', { req: true, max: 160 }), f.d('birth_date'), f.s('sex', { max: 20 }), f.d('admission_date'), f.d('discharge_date'),
    f.s('status', { enum: ['admitted', 'discharged', 'transferred', 'deceased'] }), f.s('bed_id', { ref: 'beds', max: 64 }), f.s('clinical_responsible_user_id', { ref: 'users', max: 64 }),
    f.j('diagnoses', { enc: true }), f.j('allergies', { enc: true }), f.j('intolerances', { enc: true }), f.j('restrictions', { enc: true }),
    f.b('dysphagia'), f.s('consistency', { enum: CONSISTENCIES }), f.s('feeding_route', { enum: ROUTES }),
    f.j('nutritional_needs', { enc: true }), f.j('nutritional_risk', { enc: true }), f.s('user_id', { ref: 'users', max: 64 })
  ],
  hooks: {
    async beforeWrite(c, data, existing) {
      if (data.bed_id) {
        const unit = data.unit_id ?? existing?.unit_id
        const bed = await c.env.DB.prepare('SELECT unit_id,status FROM beds WHERE id=? AND org_id=?').bind(data.bed_id, c.get('auth').orgId).first<any>()
        if (!bed || bed.unit_id !== unit) throw bad('invalid_bed', 'Leito inexistente ou de outra unidade')
        const other = await c.env.DB.prepare("SELECT 1 FROM patients WHERE bed_id=? AND status='admitted' AND id<>?").bind(data.bed_id, existing?.id ?? '').first()
        if (other || (bed.status !== 'free' && data.bed_id !== existing?.bed_id)) throw conflict('bed_unavailable', 'Leito não está livre')
      }
      if (data.status && data.status !== 'admitted' && !('bed_id' in data)) data.bed_id = null
    },
    async afterWrite(c, row, existing) { await syncBeds(c, row, existing) }
  }
})

mountCrud(hospital, {
  table: 'diet_types', path: 'diet-types', read: 'hospital.read', write: 'hospital.manage', unit: false, order: 'name ASC',
  fields: [f.s('key', { req: true, max: 60 }), f.s('name', { req: true, max: 120 }), f.s('description', { max: 500 }), f.j('rules'), f.b('active')]
})

// ---------- notas e exames ----------
async function inheritPatientUnit(c: AppCtx, data: Record<string, any>) {
  if (data.patient_id) {
    const p = await guardSubject(c, 'patient', data.patient_id, 'write')
    data.unit_id = p.unit_id
  }
}
mountCrud(hospital, {
  table: 'clinical_notes', path: 'clinical-notes', read: 'clinical.read', write: 'clinical.write', unit: 'strict', order: 'created_at DESC', filters: ['patient_id'], auditRead: true,
  fields: [f.s('patient_id', { req: true, ref: 'patients', max: 64 }), f.s('kind', { enum: ['evolucao', 'anamnese', 'conduta', 'alta'] }), f.s('content', { req: true, enc: true, max: 8000 })],
  hooks: { async beforeWrite(c, data, existing) { await inheritPatientUnit(c, data); if (!existing) (data as any).created_by = c.get('auth').userId } }
})
mountCrud(hospital, {
  table: 'exams', path: 'exams', read: 'clinical.read', write: 'clinical.write', unit: 'strict', order: 'date DESC', filters: ['patient_id'], auditRead: true,
  fields: [f.s('patient_id', { req: true, ref: 'patients', max: 64 }), f.d('date', { req: true }), f.s('name', { req: true, max: 120 }), f.s('value', { req: true, max: 120 }), f.s('unit', { max: 30 }), f.s('reference', { max: 120 })],
  hooks: { async beforeWrite(c, data, existing) { await inheritPatientUnit(c, data); if (!existing) (data as any).created_by = c.get('auth').userId } }
})

// ---------- prescrições dietéticas (histórico versionado) ----------
function rxView(r: any) {
  return { ...r, restrictions: parseJson(r.restrictions, []), supplementation: parseJson(r.supplementation, []) }
}
hospital.get('/diet-prescriptions', need('clinical.read'), async (c) => {
  const q = new URL(c.req.url).searchParams
  const p = await guardSubject(c, 'patient', q.get('patient_id'), 'read')
  const rows = (await c.env.DB.prepare('SELECT * FROM diet_prescriptions WHERE org_id=? AND patient_id=? ORDER BY prescribed_at DESC').bind(c.get('auth').orgId, p.id).all<any>()).results
  await audit(c, 'list', 'diet_prescriptions', p.id)
  return c.json({ items: rows.map(rxView) })
})
hospital.post('/diet-prescriptions', need('hospital.prescribe'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const p = await guardSubject(c, 'patient', b.patient_id, 'write')
  assertCan(a, 'hospital.prescribe', p.unit_id)
  if (p.row.status !== 'admitted') throw conflict('not_admitted', 'Paciente não está internado')
  const dt = await c.env.DB.prepare('SELECT id,active FROM diet_types WHERE id=? AND org_id=?').bind(String(b.diet_type_id ?? ''), a.orgId).first<any>()
  if (!dt || !dt.active) throw bad('invalid_reference', 'Tipo de dieta inválido ou inativo')
  const consistency = b.consistency ?? p.row.consistency ?? 'normal', route = b.feeding_route ?? p.row.feeding_route ?? 'oral'
  if (!CONSISTENCIES.includes(consistency)) throw bad('invalid_field', 'Consistência inválida')
  if (!ROUTES.includes(route)) throw bad('invalid_field', 'Via inválida')
  const prev = await c.env.DB.prepare("SELECT id FROM diet_prescriptions WHERE org_id=? AND patient_id=? AND status='active'").bind(a.orgId, p.id).first<any>()
  if (prev && !String(b.change_reason ?? '').trim()) throw bad('change_reason_required', 'Informe change_reason ao alterar uma prescrição vigente')
  const id = uid(), ts = nowIso()
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE diet_prescriptions SET status='superseded', valid_to=?, updated_at=? WHERE org_id=? AND patient_id=? AND status='active'").bind(today(), ts, a.orgId, p.id),
    c.env.DB.prepare('INSERT INTO diet_prescriptions (id,org_id,unit_id,patient_id,diet_type_id,consistency,feeding_route,restrictions,supplementation,notes,valid_from,status,prescribed_by,prescribed_at,change_reason,prev_prescription_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, a.orgId, p.unit_id, p.id, dt.id, consistency, route, JSON.stringify(Array.isArray(b.restrictions) ? b.restrictions : []), JSON.stringify(Array.isArray(b.supplementation) ? b.supplementation : []),
        b.notes ? String(b.notes).slice(0, 2000) : null, b.valid_from ?? today(), 'active', a.userId, ts, b.change_reason ?? null, prev?.id ?? null, ts, ts)
  ])
  await audit(c, 'create', 'diet_prescriptions', id, { patient_id: p.id, supersedes: prev?.id ?? null })
  return c.json(rxView(await c.env.DB.prepare('SELECT * FROM diet_prescriptions WHERE id=?').bind(id).first()), 201)
})

// ---------- motor de conflitos ----------
export interface Conflict { code: string; level: 'critical' | 'warning'; message: string; detail?: string }
const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x))
const hit = (needle: string, hay: string[]) => { const n = norm(needle); return !!n && hay.some((h) => { const x = norm(h); return x.includes(n) || n.includes(x) }) }

async function decField(c: AppCtx, table: string, field: string, row: any) {
  return decryptValue<unknown>(c.env, row[field], `${table}.${field}.${row.id}`)
}

/** Avalia paciente + prescrição vigente + receita. Retorna a lista de conflitos. Alergias confirmadas = críticas. */
export async function evaluateMeal(c: AppCtx, patient: any, rx: any | null, recipeId: string | null): Promise<Conflict[]> {
  const a = c.get('auth'), out: Conflict[] = []
  if (!rx) { out.push({ code: 'no_prescription', level: 'critical', message: 'Paciente sem prescrição dietética vigente' }); return out }
  if (!recipeId) { out.push({ code: 'no_recipe', level: 'critical', message: 'Refeição sem preparação definida' }); return out }
  const calc = await recipeCalc(c.env, a.orgId!, recipeId)
  if (!calc) { out.push({ code: 'no_recipe', level: 'critical', message: 'Receita inexistente' }); return out }
  const allergies = asList(await decField(c, 'patients', 'allergies', patient))
  const intolerances = asList(await decField(c, 'patients', 'intolerances', patient))
  const restrictions = [...asList(await decField(c, 'patients', 'restrictions', patient)), ...parseJson<string[]>(rx.restrictions, [])]
  const ingredientNames = calc.items.map((i) => i.food_name)
  const bag = [...calc.allergens, ...calc.tags, ...ingredientNames]
  for (const al of allergies) if (hit(al, bag)) out.push({ code: 'allergy', level: 'critical', message: `Alergia registrada (${al}) presente na preparação`, detail: al })
  for (const it of intolerances) if (hit(it, bag)) out.push({ code: 'intolerance', level: 'warning', message: `Intolerância registrada (${it}) possivelmente presente`, detail: it })
  for (const rs of restrictions) if (hit(rs, bag)) out.push({ code: 'restriction', level: 'warning', message: `Restrição (${rs}) possivelmente presente`, detail: rs })
  const cons = rx.consistency ?? 'normal'
  if (cons !== 'normal' && !calc.tags.map(norm).includes(`consistencia:${cons}`)) {
    out.push({ code: 'consistency', level: patient.dysphagia ? 'critical' : 'warning', message: `Preparação não está marcada como consistência "${cons}" (tag consistencia:${cons})` })
  }
  const route = rx.feeding_route ?? 'oral'
  if (route !== 'oral' && !calc.tags.map(norm).includes(`via:${route}`)) out.push({ code: 'feeding_route', level: 'critical', message: `Via de alimentação "${route}" incompatível com a preparação (tag via:${route})` })
  const dt = await c.env.DB.prepare('SELECT rules FROM diet_types WHERE id=? AND org_id=?').bind(rx.diet_type_id, a.orgId).first<any>()
  const rules = parseJson<Record<string, any>>(dt?.rules, {})
  for (const al of asList(rules.forbidden_allergens)) if (hit(al, calc.allergens)) out.push({ code: 'diet_rule', level: 'critical', message: `Dieta não permite alérgeno "${al}"`, detail: al })
  for (const tg of asList(rules.forbidden_tags)) if (hit(tg, calc.tags)) out.push({ code: 'diet_rule', level: 'critical', message: `Dieta não permite preparações "${tg}"`, detail: tg })
  for (const ing of asList(rules.forbidden_ingredients)) if (hit(ing, ingredientNames)) out.push({ code: 'diet_rule', level: 'critical', message: `Dieta não permite ingrediente "${ing}"`, detail: ing })
  if (typeof rules.max_sodium_mg_per_meal === 'number' && calc.nutrition_per_portion.sodium_mg > rules.max_sodium_mg_per_meal) {
    out.push({ code: 'diet_rule', level: 'warning', message: `Sódio por porção (${calc.nutrition_per_portion.sodium_mg} mg) acima do limite da dieta (${rules.max_sodium_mg_per_meal} mg)` })
  }
  if (!calc.nutrition_complete) out.push({ code: 'incomplete_nutrition', level: 'warning', message: 'Composição nutricional incompleta (ingredientes sem dados)' })
  if (Date.parse(rx.prescribed_at) > Date.now() - 24 * 3600 * 1000 && rx.prev_prescription_id) out.push({ code: 'recent_change', level: 'warning', message: 'Prescrição alterada nas últimas 24 h — confirme a mudança com a equipe' })
  return out
}
const levelOf = (cs: Conflict[]) => (cs.some((x) => x.level === 'critical') ? 'critical' : cs.length ? 'warning' : 'none')

async function activeRx(c: AppCtx, patientId: string) {
  return c.env.DB.prepare("SELECT * FROM diet_prescriptions WHERE org_id=? AND patient_id=? AND status='active' ORDER BY prescribed_at DESC LIMIT 1").bind(c.get('auth').orgId, patientId).first<any>()
}
async function logEvent(c: AppCtx, orderId: string, action: string, note?: string | null) {
  await c.env.DB.prepare('INSERT INTO meal_order_events (id,org_id,meal_order_id,action,user_id,note,ts) VALUES (?,?,?,?,?,?,?)').bind(uid(), c.get('auth').orgId, orderId, action, c.get('auth').userId, note ?? null, nowIso()).run()
}
async function recipeOk(c: AppCtx, recipeId: unknown) {
  const r = await c.env.DB.prepare('SELECT status FROM recipes WHERE id=? AND org_id=?').bind(String(recipeId ?? ''), c.get('auth').orgId).first<any>()
  if (!r) throw bad('invalid_reference', 'Receita inválida')
  if (r.status !== 'approved') throw bad('recipe_not_approved', 'Somente fichas técnicas aprovadas podem ser servidas a pacientes')
}

// ---------- pedidos de refeição ----------
hospital.post('/meal-orders/generate', need('hospital.prescribe'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const unitId = String(b.unit_id ?? ''), date = String(b.date ?? today())
  assertCan(a, 'hospital.prescribe', unitId)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('invalid_field', 'date inválida')
  const meals: any[] = Array.isArray(b.meals) ? b.meals : []
  if (!meals.length) throw bad('missing_field', 'Informe meals: [{meal_type, recipe_id, scheduled_time?}]')
  const dietRecipes: Record<string, Record<string, string>> = b.diet_recipes && typeof b.diet_recipes === 'object' ? b.diet_recipes : {}
  for (const m of meals) {
    if (!MEALS.includes(m.meal_type)) throw bad('invalid_field', `meal_type inválido: ${m.meal_type}`)
    if (m.recipe_id) await recipeOk(c, m.recipe_id)
  }
  for (const per of Object.values(dietRecipes)) for (const rid of Object.values(per)) await recipeOk(c, rid)
  const patients = (await c.env.DB.prepare("SELECT * FROM patients WHERE org_id=? AND unit_id=? AND status='admitted'").bind(a.orgId, unitId).all<any>()).results
  const dietKeys = new Map((await c.env.DB.prepare('SELECT id,key FROM diet_types WHERE org_id=?').bind(a.orgId).all<any>()).results.map((d) => [d.id, d.key]))
  let created = 0, skipped = 0, critical = 0
  for (const p of patients) {
    const rx = await activeRx(c, p.id)
    for (const m of meals) {
      const exists = await c.env.DB.prepare('SELECT status FROM meal_orders WHERE org_id=? AND patient_id=? AND date=? AND meal_type=?').bind(a.orgId, p.id, date, m.meal_type).first<any>()
      if (exists) { skipped++; continue }
      const dk = rx ? dietKeys.get(rx.diet_type_id) : undefined
      const recipeId = (dk && dietRecipes[dk]?.[m.meal_type]) ?? m.recipe_id ?? null
      const cs = await evaluateMeal(c, p, rx, recipeId)
      if (levelOf(cs) === 'critical') critical++
      const id = uid(), ts = nowIso()
      await c.env.DB.prepare('INSERT INTO meal_orders (id,org_id,unit_id,patient_id,bed_id,date,meal_type,scheduled_time,recipe_id,prescription_id,status,conflicts,conflict_level,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, a.orgId, unitId, p.id, p.bed_id, date, m.meal_type, m.scheduled_time ?? null, recipeId, rx?.id ?? null, 'pending', JSON.stringify(cs), levelOf(cs), ts, ts).run()
      await logEvent(c, id, 'generated')
      created++
    }
  }
  await audit(c, 'generate', 'meal_orders', undefined, { unit_id: unitId, date, created, skipped, critical })
  return c.json({ created, skipped, with_critical_conflicts: critical }, 201)
})

async function loadOrder(c: AppCtx, id: string, perm: string) {
  const o = await c.env.DB.prepare('SELECT * FROM meal_orders WHERE id=? AND org_id=?').bind(id, c.get('auth').orgId).first<any>()
  if (!o || !can(c.get('auth'), perm, o.unit_id)) throw notFound('Pedido')
  return o
}
const canSeeClinical = (c: AppCtx, unit: string) => can(c.get('auth'), 'clinical.read', unit)
async function orderView(c: AppCtx, o: any, p: any) {
  const clinical = canSeeClinical(c, o.unit_id)
  const allergies = asList(await decField(c, 'patients', 'allergies', p))
  return {
    id: o.id, unit_id: o.unit_id, date: o.date, meal_type: o.meal_type, scheduled_time: o.scheduled_time, status: o.status, recipe_id: o.recipe_id,
    patient: { id: p.id, name: p.name, internal_code: p.internal_code, bed_id: o.bed_id, consistency: p.consistency, feeding_route: p.feeding_route },
    allergy_alert: allergies.length > 0, allergies: clinical ? allergies : undefined,
    conflict_level: o.conflict_level, conflicts: parseJson(o.conflicts, []),
    conferred_at: o.conferred_at, released_at: o.released_at, produced_at: o.produced_at, delivered_at: o.delivered_at, label_code: o.label_code, warnings_ack_note: o.warnings_ack_note
  }
}
hospital.get('/meal-orders', need('hospital.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const scope = unitScope(a, 'hospital.read')
  const where = ['o.org_id=?'], params: unknown[] = [a.orgId]
  if (scope !== null) { where.push(`o.unit_id IN (${scope.map(() => '?').join(',') || "''"})`); params.push(...scope) }
  for (const k of ['unit_id', 'date', 'status', 'meal_type', 'conflict_level']) { const v = q.get(k); if (v) { where.push(`o.${k}=?`); params.push(v) } }
  const rows = (await c.env.DB.prepare(`SELECT o.* FROM meal_orders o WHERE ${where.join(' AND ')} ORDER BY o.date DESC, o.meal_type LIMIT 500`).bind(...params).all<any>()).results
  const items = []
  for (const o of rows) { const p = await c.env.DB.prepare('SELECT * FROM patients WHERE id=?').bind(o.patient_id).first<any>(); items.push(await orderView(c, o, p)) }
  return c.json({ items })
})
hospital.get('/meal-orders/:id', need('hospital.read'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.read')
  const events = (await c.env.DB.prepare('SELECT action,user_id,note,ts FROM meal_order_events WHERE meal_order_id=? ORDER BY ts').bind(o.id).all()).results
  return c.json({ ...(await orderView(c, o, await c.env.DB.prepare('SELECT * FROM patients WHERE id=?').bind(o.patient_id).first())), events })
})
async function recheck(c: AppCtx, o: any) {
  const p = await c.env.DB.prepare('SELECT * FROM patients WHERE id=?').bind(o.patient_id).first<any>()
  const rx = await activeRx(c, p.id)
  const cs = await evaluateMeal(c, p, rx, o.recipe_id)
  await c.env.DB.prepare('UPDATE meal_orders SET conflicts=?, conflict_level=?, prescription_id=?, bed_id=?, updated_at=? WHERE id=?').bind(JSON.stringify(cs), levelOf(cs), rx?.id ?? null, p.bed_id, nowIso(), o.id).run()
  return { cs, level: levelOf(cs), p }
}
// substituir a preparação (única forma de resolver conflito crítico)
hospital.put('/meal-orders/:id', need('hospital.prescribe'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.prescribe')
  if (!['pending', 'conferred'].includes(o.status)) throw conflict('invalid_state', 'Pedido já liberado/produzido não pode ser alterado')
  const b = await readBody(c)
  await recipeOk(c, b.recipe_id)
  await c.env.DB.prepare("UPDATE meal_orders SET recipe_id=?, status='pending', conferred_by=NULL, conferred_at=NULL, warnings_ack_by=NULL, warnings_ack_note=NULL WHERE id=?").bind(b.recipe_id, o.id).run()
  const r = await recheck(c, { ...o, recipe_id: b.recipe_id })
  await logEvent(c, o.id, 'recipe_changed', String(b.reason ?? ''))
  await audit(c, 'update', 'meal_orders', o.id, { recipe_changed: true })
  return c.json(await orderView(c, await c.env.DB.prepare('SELECT * FROM meal_orders WHERE id=?').bind(o.id).first(), r.p))
})
hospital.post('/meal-orders/:id/recheck', need('hospital.read'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.read')
  if (['produced', 'delivered', 'cancelled'].includes(o.status)) throw conflict('invalid_state', 'Pedido já produzido')
  const r = await recheck(c, o)
  if (r.level === 'critical' && o.status !== 'pending') {
    await c.env.DB.prepare("UPDATE meal_orders SET status='pending', released_by=NULL, released_at=NULL, conferred_by=NULL, conferred_at=NULL WHERE id=?").bind(o.id).run()
    await logEvent(c, o.id, 'reverted_by_recheck', 'Conflito crítico detectado na reavaliação')
  }
  return c.json({ conflict_level: r.level, conflicts: r.cs })
})
hospital.post('/meal-orders/:id/confer', need('hospital.confer'), async (c) => {
  const a = c.get('auth')
  const o = await loadOrder(c, c.req.param('id'), 'hospital.confer')
  if (o.status !== 'pending') throw conflict('invalid_state', 'Somente pedidos pendentes podem ser conferidos')
  const r = await recheck(c, o)
  if (r.level === 'critical') throw conflict('critical_conflict', 'Conflito crítico: substitua a preparação antes de conferir. Não há liberação por exceção.', r.cs)
  const b = await readBody(c)
  if (r.level === 'warning' && String(b.ack_note ?? '').trim().length < 5) throw bad('ack_required', 'Há alertas: confirme com ack_note (mín. 5 caracteres)', r.cs)
  await c.env.DB.prepare("UPDATE meal_orders SET status='conferred', conferred_by=?, conferred_at=?, warnings_ack_by=?, warnings_ack_note=? WHERE id=?")
    .bind(a.userId, nowIso(), r.level === 'warning' ? a.userId : null, r.level === 'warning' ? String(b.ack_note) : null, o.id).run()
  await logEvent(c, o.id, 'conferred', b.ack_note)
  await audit(c, 'confer', 'meal_orders', o.id, { level: r.level })
  return c.json({ ok: true, conflict_level: r.level })
})
hospital.post('/meal-orders/:id/release', need('hospital.release'), async (c) => {
  const a = c.get('auth')
  const o = await loadOrder(c, c.req.param('id'), 'hospital.release')
  if (o.status !== 'conferred') throw conflict('not_conferred', 'O pedido precisa ser conferido antes da liberação')
  const r = await recheck(c, o) // reavalia: o paciente pode ter mudado desde a conferência
  if (r.level === 'critical') {
    await c.env.DB.prepare("UPDATE meal_orders SET status='pending', conferred_by=NULL, conferred_at=NULL WHERE id=?").bind(o.id).run()
    await logEvent(c, o.id, 'release_blocked', 'Conflito crítico')
    await audit(c, 'release_blocked', 'meal_orders', o.id)
    throw conflict('critical_conflict', 'Liberação bloqueada por conflito crítico.', r.cs)
  }
  const label = 'NV-' + o.id.replace(/-/g, '').slice(0, 8).toUpperCase()
  await c.env.DB.prepare("UPDATE meal_orders SET status='released', released_by=?, released_at=?, label_code=? WHERE id=?").bind(a.userId, nowIso(), label, o.id).run()
  await logEvent(c, o.id, 'released')
  await audit(c, 'release', 'meal_orders', o.id)
  return c.json({ ok: true, label_code: label })
})
hospital.post('/meal-orders/:id/produce', need('hospital.produce'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.produce')
  if (o.status !== 'released') throw conflict('not_released', 'Somente pedidos liberados podem ser produzidos')
  await c.env.DB.prepare("UPDATE meal_orders SET status='produced', produced_by=?, produced_at=? WHERE id=?").bind(c.get('auth').userId, nowIso(), o.id).run()
  await logEvent(c, o.id, 'produced'); await audit(c, 'produce', 'meal_orders', o.id)
  return c.json({ ok: true })
})
hospital.post('/meal-orders/:id/deliver', need('hospital.deliver'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.deliver')
  if (o.status !== 'produced') throw conflict('not_produced', 'Somente pedidos produzidos podem ser entregues')
  await c.env.DB.prepare("UPDATE meal_orders SET status='delivered', delivered_by=?, delivered_at=? WHERE id=?").bind(c.get('auth').userId, nowIso(), o.id).run()
  await logEvent(c, o.id, 'delivered'); await audit(c, 'deliver', 'meal_orders', o.id)
  return c.json({ ok: true })
})
hospital.post('/meal-orders/:id/cancel', need('hospital.prescribe'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.prescribe')
  if (['delivered', 'cancelled'].includes(o.status)) throw conflict('invalid_state', 'Pedido já finalizado')
  const b = await readBody(c)
  await c.env.DB.prepare("UPDATE meal_orders SET status='cancelled' WHERE id=?").bind(o.id).run()
  await logEvent(c, o.id, 'cancelled', b.reason); await audit(c, 'cancel', 'meal_orders', o.id)
  return c.json({ ok: true })
})
hospital.get('/meal-orders/:id/label', need('hospital.read'), async (c) => {
  const o = await loadOrder(c, c.req.param('id'), 'hospital.read')
  if (!o.label_code) throw conflict('not_released', 'Etiqueta disponível apenas após a liberação')
  const p = await c.env.DB.prepare('SELECT * FROM patients WHERE id=?').bind(o.patient_id).first<any>()
  const rc = o.recipe_id ? await c.env.DB.prepare('SELECT name FROM recipes WHERE id=?').bind(o.recipe_id).first<any>() : null
  const bed = o.bed_id ? await c.env.DB.prepare('SELECT code FROM beds WHERE id=?').bind(o.bed_id).first<any>() : null
  const allergies = asList(await decField(c, 'patients', 'allergies', p))
  return c.json({ label_code: o.label_code, patient: p.name, internal_code: p.internal_code, bed: bed?.code ?? null, date: o.date, meal_type: o.meal_type, preparation: rc?.name ?? null, consistency: p.consistency, feeding_route: p.feeding_route, allergy_alert: allergies.length > 0, allergies })
})

// ---------- mapas ----------
hospital.get('/hospital/meal-map', need('hospital.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const unitId = q.get('unit_id') ?? '', date = q.get('date') ?? today()
  assertCan(a, 'hospital.read', unitId)
  const rows = (await c.env.DB.prepare(`SELECT o.*, b.code AS bed_code FROM meal_orders o LEFT JOIN beds b ON b.id=o.bed_id WHERE o.org_id=? AND o.unit_id=? AND o.date=? AND o.status<>'cancelled' ORDER BY o.meal_type, b.code`).bind(a.orgId, unitId, date).all<any>()).results
  const map: Record<string, any[]> = {}
  for (const o of rows) {
    const p = await c.env.DB.prepare('SELECT * FROM patients WHERE id=?').bind(o.patient_id).first<any>()
    const rc = o.recipe_id ? await c.env.DB.prepare('SELECT name FROM recipes WHERE id=?').bind(o.recipe_id).first<any>() : null
    const v = await orderView(c, o, p)
    ;(map[o.meal_type] ??= []).push({ order_id: o.id, bed: o.bed_code, patient: p.name, preparation: rc?.name ?? null, consistency: p.consistency, feeding_route: p.feeding_route, allergy_alert: v.allergy_alert, allergies: v.allergies, status: o.status, conflict_level: o.conflict_level })
  }
  return c.json({ unit_id: unitId, date, meals: map })
})
hospital.get('/hospital/production-map', needAny('hospital.produce', 'hospital.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const unitId = q.get('unit_id') ?? '', date = q.get('date') ?? today()
  assertCan(a, 'hospital.read', unitId)
  const rows = (await c.env.DB.prepare(`SELECT o.meal_type, o.recipe_id, r.name AS recipe, COUNT(*) AS portions, SUM(CASE WHEN o.status IN ('released','produced','delivered') THEN 1 ELSE 0 END) AS released
    FROM meal_orders o LEFT JOIN recipes r ON r.id=o.recipe_id WHERE o.org_id=? AND o.unit_id=? AND o.date=? AND o.status<>'cancelled' GROUP BY o.meal_type, o.recipe_id ORDER BY o.meal_type`).bind(a.orgId, unitId, date).all<any>()).results
  return c.json({ unit_id: unitId, date, items: rows, note: 'Somente pedidos liberados entram em produção' })
})

// ---------- ocorrências ----------
mountCrud(hospital, {
  table: 'occurrences', path: 'occurrences', read: 'hospital.read', write: 'hospital.read', unit: 'loose', order: 'created_at DESC', filters: ['resolved'],
  fields: [f.s('meal_order_id', { ref: 'meal_orders', max: 64 }), f.s('kind', { req: true, enum: ['recusa', 'atraso', 'erro_preparo', 'erro_entrega', 'reacao', 'outro'] }), f.s('description', { req: true, max: 2000 }), f.b('resolved')],
  hooks: { beforeWrite(c, data, existing) { if (!existing) (data as any).created_by = c.get('auth').userId } }
})

// ---------- painel hospitalar ----------
hospital.get('/dashboard/hospital', need('hospital.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams
  const scope = unitScope(a, 'hospital.read')
  const uf = scope === null ? '' : `AND unit_id IN (${scope.map(() => '?').join(',') || "''"})`
  const up = scope ?? []
  const date = q.get('date') ?? today()
  const rows = async (sql: string, ...p: unknown[]) => (await c.env.DB.prepare(sql).bind(a.orgId, ...up, ...p).all<any>()).results
  const orders = await rows(`SELECT status, conflict_level, COUNT(*) n FROM meal_orders WHERE org_id=? ${uf} AND date=? GROUP BY status, conflict_level`, date)
  const beds = await rows(`SELECT status, COUNT(*) n FROM beds WHERE org_id=? ${uf} GROUP BY status`)
  const adm = (await rows(`SELECT COUNT(*) n FROM patients WHERE org_id=? ${uf} AND status='admitted'`))[0]?.n ?? 0
  const occ = (await rows(`SELECT COUNT(*) n FROM occurrences WHERE org_id=? ${uf.replace('unit_id', 'unit_id')} AND resolved=0`))[0]?.n ?? 0
  const by = (f2: (r: any) => boolean) => orders.filter(f2).reduce((s, r) => s + r.n, 0)
  const total = by(() => true)
  return c.json({
    date, admitted_patients: adm, beds_by_status: Object.fromEntries(beds.map((b) => [b.status, b.n])),
    orders_total: total, orders_by_status: Object.fromEntries(Object.entries(orders.reduce((m: any, r) => ((m[r.status] = (m[r.status] ?? 0) + r.n), m), {}))),
    pending_with_critical_conflict: by((r) => r.status === 'pending' && r.conflict_level === 'critical'),
    pending_with_warning: by((r) => r.status === 'pending' && r.conflict_level === 'warning'),
    delivered_pct: total ? Math.round((by((r) => r.status === 'delivered') / total) * 1000) / 10 : null,
    open_occurrences: occ
  })
})

import { Hono } from 'hono'
import { type AppCtx, type AppEnv, assertCan, audit, can, need, needAny, requireUnit, unitScope } from '../lib/auth'
import { f, mountCrud } from '../lib/crud'
import { recipeCalc, NUTRIENTS } from '../lib/calc'
import { decryptValue } from '../lib/crypto'
import { bad, conflict, forbidden, nowIso, norm, notFound, num, parseJson, readBody, round, today, uid } from '../lib/util'

export const ops = new Hono<AppEnv>()

// ================= qualidade e segurança alimentar =================
const Q = { read: 'quality.read', write: 'quality.write' }
mountCrud(ops, { table: 'checklist_templates', path: 'checklist-templates', ...Q, unit: 'loose', order: 'name ASC',
  fields: [f.s('name', { req: true, max: 160 }), f.s('kind', { enum: ['boas_praticas', 'recebimento', 'higienizacao', 'temperatura', 'outro'] }), f.j('items', { req: true }), f.s('procedure_ref', { max: 300 })],
  hooks: { beforeWrite(_c, d) { if ('items' in d) { const it = Array.isArray(d.items) ? d.items : []; if (!Array.isArray(it) || !it.length || it.some((x) => !x?.id || !x?.text)) throw bad('invalid_field', 'items: [{id, text, critical?}] obrigatório') } } } })

async function openNc(c: AppCtx, unitId: string, title: string, description: string, source: string, severity: string) {
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO nonconformities (id,org_id,unit_id,title,description,source,severity,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, c.get('auth').orgId, unitId, title, description, source, severity, 'open', c.get('auth').userId, ts, ts).run()
  await audit(c, 'create', 'nonconformities', id, { source, severity })
  return id
}
ops.post('/checklist-runs', need('quality.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await requireUnit(c, 'quality.write', b.unit_id)
  const t = await c.env.DB.prepare('SELECT * FROM checklist_templates WHERE id=? AND org_id=?').bind(String(b.template_id ?? ''), a.orgId).first<any>()
  if (!t) throw bad('invalid_reference', 'Modelo inválido')
  const items: any[] = parseJson(t.items, []), answers: any[] = Array.isArray(b.answers) ? b.answers : []
  const byId = new Map(answers.map((x) => [x.item_id, x]))
  const missing = items.filter((i) => !byId.has(i.id)).map((i) => i.id)
  if (missing.length) throw bad('incomplete_checklist', 'Responda todos os itens', missing)
  const failed = items.filter((i) => byId.get(i.id).ok !== true)
  const score = round(((items.length - failed.length) / items.length) * 100, 1)
  const critical = failed.filter((i) => i.critical)
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO checklist_runs (id,org_id,unit_id,template_id,performed_by,date,answers,score,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, u, t.id, a.userId, b.date ?? today(), JSON.stringify(answers.slice(0, 200).map((x) => ({ item_id: x.item_id, ok: x.ok === true, note: x.note ? String(x.note).slice(0, 300) : null }))), score, failed.length ? 'with_failures' : 'done', ts, ts).run()
  let ncId: string | null = null
  if (failed.length) ncId = await openNc(c, u, `Checklist "${t.name}": ${failed.length} item(ns) não conforme(s)`, failed.map((i) => i.text).join('; '), 'checklist', critical.length ? 'critical' : 'minor')
  await audit(c, 'create', 'checklist_runs', id, { score })
  return c.json({ id, score, failed: failed.map((i) => i.id), nonconformity_id: ncId }, 201)
})
ops.get('/checklist-runs', need('quality.read'), async (c) => {
  const a = c.get('auth'), s = unitScope(a, 'quality.read')
  const rows = (await c.env.DB.prepare(`SELECT * FROM checklist_runs WHERE org_id=? ${s === null ? '' : `AND unit_id IN (${s.map(() => '?').join(',') || "''"})`} ORDER BY date DESC, created_at DESC LIMIT 200`).bind(a.orgId, ...(s ?? [])).all<any>()).results
  return c.json({ items: rows.map((r) => ({ ...r, answers: parseJson(r.answers, []) })) })
})
ops.post('/temperature-logs', needAny('quality.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await requireUnit(c, 'quality.write', b.unit_id)
  const reading = Number(b.reading_c)
  if (!String(b.equipment ?? '').trim() || !Number.isFinite(reading)) throw bad('missing_field', 'Informe equipment e reading_c')
  const mn = b.limit_min_c != null ? Number(b.limit_min_c) : null, mx = b.limit_max_c != null ? Number(b.limit_max_c) : null
  if (mn == null && mx == null) throw bad('missing_field', 'Informe limit_min_c e/ou limit_max_c (limites definidos pela organização/legislação aplicável)')
  const ok = (mn == null || reading >= mn) && (mx == null || reading <= mx)
  let nc: string | null = null
  if (!ok) nc = await openNc(c, u, `Temperatura fora do limite: ${b.equipment}`, `Leitura ${reading} °C (limites: ${mn ?? '-'} a ${mx ?? '-'} °C)`, 'temperature', 'major')
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO temperature_logs (id,org_id,unit_id,equipment,reading_c,limit_min_c,limit_max_c,ok,nonconformity_id,recorded_by,recorded_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, u, String(b.equipment).slice(0, 120), reading, mn, mx, ok ? 1 : 0, nc, a.userId, b.recorded_at ?? ts, ts, ts).run()
  await audit(c, 'create', 'temperature_logs', id, { ok })
  return c.json({ id, ok, nonconformity_id: nc }, 201)
})
ops.get('/temperature-logs', need('quality.read'), async (c) => {
  const a = c.get('auth'), q = new URL(c.req.url).searchParams, s = unitScope(a, 'quality.read')
  const where = ['org_id=?'], p: unknown[] = [a.orgId]
  if (s !== null) { where.push(`unit_id IN (${s.map(() => '?').join(',') || "''"})`); p.push(...s) }
  if (q.get('unit_id')) { where.push('unit_id=?'); p.push(q.get('unit_id')) }
  if (q.get('ok') != null && q.get('ok') !== '') { where.push('ok=?'); p.push(q.get('ok') === '1' || q.get('ok') === 'true' ? 1 : 0) }
  return c.json({ items: (await c.env.DB.prepare(`SELECT * FROM temperature_logs WHERE ${where.join(' AND ')} ORDER BY recorded_at DESC LIMIT 300`).bind(...p).all()).results })
})
ops.post('/receiving-records', need('quality.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c), u = await requireUnit(c, 'quality.write', b.unit_id)
  if (!String(b.product ?? '').trim()) throw bad('missing_field', 'Informe product')
  const accepted = b.accepted !== false
  if (!accepted && !String(b.notes ?? '').trim()) throw bad('notes_required', 'Recusa exige justificativa em notes')
  if (b.supplier_id && !(await c.env.DB.prepare('SELECT 1 FROM suppliers WHERE id=? AND org_id=?').bind(b.supplier_id, a.orgId).first())) throw bad('invalid_reference', 'Fornecedor inválido')
  if (b.evidence_doc_id && !(await c.env.DB.prepare('SELECT 1 FROM documents WHERE id=? AND org_id=?').bind(b.evidence_doc_id, a.orgId).first())) throw bad('invalid_reference', 'Documento inválido')
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO receiving_records (id,org_id,unit_id,supplier_id,product,lot_code,temperature_c,expiry,accepted,evidence_doc_id,notes,recorded_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, u, b.supplier_id ?? null, String(b.product).slice(0, 160), b.lot_code ?? null, b.temperature_c ?? null, b.expiry ?? null, accepted ? 1 : 0, b.evidence_doc_id ?? null, b.notes ?? null, a.userId, ts, ts).run()
  const nc = accepted ? null : await openNc(c, u, `Recebimento recusado: ${b.product}`, String(b.notes), 'receiving', 'major')
  await audit(c, 'create', 'receiving_records', id, { accepted })
  return c.json({ id, accepted, nonconformity_id: nc }, 201)
})
ops.get('/receiving-records', need('quality.read'), async (c) => {
  const a = c.get('auth'), s = unitScope(a, 'quality.read')
  return c.json({ items: (await c.env.DB.prepare(`SELECT * FROM receiving_records WHERE org_id=? ${s === null ? '' : `AND unit_id IN (${s.map(() => '?').join(',') || "''"})`} ORDER BY created_at DESC LIMIT 200`).bind(a.orgId, ...(s ?? [])).all()).results })
})
mountCrud(ops, { table: 'nonconformities', path: 'nonconformities', ...Q, unit: 'strict', unitReq: true, filters: ['unit_id', 'status', 'severity'], order: 'created_at DESC', del: false,
  fields: [f.s('title', { req: true, max: 200 }), f.s('description', { max: 2000 }), f.s('severity', { enum: ['minor', 'major', 'critical'] }), f.s('responsible_user_id', { ref: 'users', max: 64 }),
    f.j('evidence_doc_ids'), f.s('source', { ro: true }), f.s('status', { ro: true })],
  hooks: { beforeWrite(c, d, ex) { if (!ex) { (d as any).created_by = c.get('auth').userId; (d as any).source = 'manual' } } } })
mountCrud(ops, { table: 'corrective_actions', path: 'corrective-actions', ...Q, unit: 'strict', filters: ['nonconformity_id'], order: 'created_at DESC',
  fields: [f.s('nonconformity_id', { req: true, ref: 'nonconformities', max: 64 }), f.s('description', { req: true, max: 1000 }), f.s('owner_user_id', { ref: 'users', max: 64 }), f.d('due_date')],
  hooks: { async beforeWrite(c, d) { if (d.nonconformity_id) { const nc = await c.env.DB.prepare('SELECT unit_id FROM nonconformities WHERE id=? AND org_id=?').bind(d.nonconformity_id, c.get('auth').orgId).first<any>(); assertCan(c.get('auth'), 'quality.write', nc?.unit_id); d.unit_id = nc?.unit_id } } } })
ops.post('/corrective-actions/:id/complete', need('quality.write'), async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM corrective_actions WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!r || !can(c.get('auth'), 'quality.write', r.unit_id)) throw notFound('Ação')
  await c.env.DB.prepare('UPDATE corrective_actions SET done_at=?, updated_at=? WHERE id=?').bind(nowIso(), nowIso(), r.id).run()
  await audit(c, 'complete', 'corrective_actions', r.id)
  return c.json({ ok: true })
})
ops.post('/nonconformities/:id/status', need('quality.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const nc = await c.env.DB.prepare('SELECT * FROM nonconformities WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!nc || !can(a, 'quality.write', nc.unit_id)) throw notFound('Não conformidade')
  if (!['open', 'in_progress', 'closed'].includes(b.status)) throw bad('invalid_field', 'status inválido')
  if (b.status === 'closed') {
    const acts = (await c.env.DB.prepare('SELECT done_at FROM corrective_actions WHERE nonconformity_id=?').bind(nc.id).all<any>()).results
    if (!acts.length) throw conflict('no_corrective_action', 'Registre ao menos uma ação corretiva antes de encerrar')
    if (acts.some((x) => !x.done_at)) throw conflict('pending_actions', 'Há ações corretivas pendentes')
  }
  await c.env.DB.prepare('UPDATE nonconformities SET status=?, closed_at=?, updated_at=? WHERE id=?').bind(b.status, b.status === 'closed' ? nowIso() : null, nowIso(), nc.id).run()
  await audit(c, 'status', 'nonconformities', nc.id, { to: b.status })
  return c.json({ ok: true })
})
ops.get('/dashboard/quality', need('quality.read'), async (c) => {
  const a = c.get('auth'), s = unitScope(a, 'quality.read'), uf = s === null ? '' : `AND unit_id IN (${s.map(() => '?').join(',') || "''"})`, up = s ?? []
  const one = async (sql: string, ...p: unknown[]) => (await c.env.DB.prepare(sql).bind(a.orgId, ...up, ...p).first<any>()) ?? {}
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const nc = (await c.env.DB.prepare(`SELECT status, severity, COUNT(*) n FROM nonconformities WHERE org_id=? ${uf} GROUP BY status, severity`).bind(a.orgId, ...up).all<any>()).results
  const t = await one(`SELECT COUNT(*) n, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) bad FROM temperature_logs WHERE org_id=? ${uf} AND recorded_at>=?`, d30)
  const ck = await one(`SELECT COUNT(*) n, AVG(score) avg FROM checklist_runs WHERE org_id=? ${uf} AND date>=?`, d30)
  const rc = await one(`SELECT COUNT(*) n, SUM(CASE WHEN accepted=0 THEN 1 ELSE 0 END) refused FROM receiving_records WHERE org_id=? ${uf} AND created_at>=?`, d30)
  return c.json({ open_nonconformities: nc.filter((x) => x.status !== 'closed').reduce((sum, x) => sum + x.n, 0), nonconformities_by_status_severity: nc, temperature_last_30d: { readings: t.n ?? 0, out_of_range: t.bad ?? 0 },
    checklists_last_30d: { runs: ck.n ?? 0, avg_score: ck.avg != null ? round(ck.avg, 1) : null }, receiving_last_30d: { records: rc.n ?? 0, refused: rc.refused ?? 0 } })
})

// ================= agenda =================
mountCrud(ops, { table: 'events', path: 'events', read: 'events.read', write: 'events.write', unit: 'loose', order: 'starts_at ASC', filters: ['kind', 'status', 'owner_user_id'],
  fields: [f.s('kind', { enum: ['consulta', 'reuniao', 'producao', 'auditoria', 'entrega', 'treino', 'outro'] }), f.s('title', { req: true, max: 200 }), f.ts('starts_at', { req: true }), f.ts('ends_at'),
    f.s('owner_user_id', { ref: 'users', max: 64 }), f.j('participants'), f.i('reminder_minutes'), f.s('status', { enum: ['scheduled', 'done', 'cancelled'] }),
    f.s('related_type', { enum: ['athlete', 'patient', 'menu', 'production_order', 'event'] }), f.s('related_id', { max: 64 }), f.s('notes', { max: 2000 })],
  hooks: { async beforeWrite(c, d) {
    if (d.ends_at && d.starts_at && d.ends_at < d.starts_at) throw bad('invalid_field', 'ends_at anterior a starts_at')
    if (d.related_type && d.related_id) {
      const tb: Record<string, string> = { athlete: 'athletes', patient: 'patients', menu: 'menus', production_order: 'production_orders', event: 'events' }
      if (!(await c.env.DB.prepare(`SELECT 1 FROM ${tb[d.related_type]} WHERE id=? AND org_id=?`).bind(d.related_id, c.get('auth').orgId).first())) throw bad('invalid_reference', 'Vínculo inválido')
    }
  } } })

// ================= IA assistiva (determinística, sem LLM externo) =================
const DISCLOSURE = 'Sugestão gerada por regras determinísticas e estatística simples sobre os dados cadastrados da própria organização. Não é decisão clínica nem automática: exige validação e aceite de um profissional responsável. Nenhum dado é enviado a serviços externos.'
async function aiGate(c: AppCtx) {
  const a = c.get('auth')
  if (!a.org?.aiEnabled) throw forbidden('IA assistiva desativada para esta organização (ative em Configurações → IA assistiva)')
  assertCan(a, 'ai.use')
}
async function saveSuggestion(c: AppCtx, kind: string, payload: unknown) {
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO ai_suggestions (id,org_id,kind,payload,disclosure,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, c.get('auth').orgId, kind, JSON.stringify(payload), DISCLOSURE, 'pending', c.get('auth').userId, ts, ts).run()
  await audit(c, 'create', 'ai_suggestions', id, { kind })
  return id
}
ops.post('/ai/suggest/substitution', need('ai.use'), async (c) => {
  await aiGate(c)
  const a = c.get('auth'), b = await readBody(c)
  const calc = await recipeCalc(c.env, a.orgId!, String(b.recipe_id ?? ''))
  if (!calc) throw bad('invalid_reference', 'Receita inválida')
  const orig = await c.env.DB.prepare('SELECT * FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(String(b.food_id ?? ''), a.orgId).first<any>()
  if (!orig || !calc.items.some((i) => i.food_id === orig.id)) throw bad('invalid_reference', 'O alimento deve ser ingrediente da receita')
  const avoid: string[] = (Array.isArray(b.avoid_allergens) ? b.avoid_allergens : []).map(norm)
  const cands = (await c.env.DB.prepare("SELECT * FROM foods WHERE (org_id=? OR org_id IS NULL) AND active=1 AND id<>? AND (category=? OR ? IS NULL) LIMIT 300").bind(a.orgId, orig.id, orig.category ?? null, orig.category ?? null).all<any>()).results
  const scoreOf = (x: any) => NUTRIENTS.reduce((s, n) => { const o = num(orig[n]); const d = Math.abs(num(x[n]) - o); return s + (o > 0 ? d / o : d > 0 ? 1 : 0) }, 0)
  const out: any[] = []
  for (const x of cands) {
    if (NUTRIENTS.some((n) => x[n] == null)) continue
    const al = parseJson<string[]>(x.allergens, [])
    if (al.some((y) => avoid.includes(norm(y)))) continue
    const sw = await recipeCalc(c.env, a.orgId!, calc.recipe_id, { from: orig.id, to: x.id })
    out.push({ food_id: x.id, name: x.name, nutrient_distance: round(scoreOf(x), 3), allergens: al, cost_per_portion: sw?.cost_complete ? sw.cost_per_portion : null, cost_delta_per_portion: sw?.cost_complete && calc.cost_complete ? round(sw.cost_per_portion - calc.cost_per_portion, 2) : null, source: x.source })
  }
  out.sort((p, q) => p.nutrient_distance - q.nutrient_distance)
  const payload = { recipe_id: calc.recipe_id, replace_food_id: orig.id, criteria: 'mesma categoria, distância relativa de macronutrientes, exclusão de alérgenos informados', candidates: out.slice(0, 5) }
  const id = await saveSuggestion(c, 'substitution', payload)
  return c.json({ id, status: 'pending', ...payload, disclosure: DISCLOSURE, data_sent_externally: false }, 201)
})
ops.post('/ai/suggest/menu-review', need('ai.use'), async (c) => {
  await aiGate(c)
  const a = c.get('auth'), b = await readBody(c)
  const m = await c.env.DB.prepare('SELECT * FROM menus WHERE id=? AND org_id=?').bind(String(b.menu_id ?? ''), a.orgId).first<any>()
  if (!m || !can(a, 'menus.read', m.unit_id)) throw notFound('Cardápio')
  const items = (await c.env.DB.prepare('SELECT * FROM menu_items WHERE menu_id=?').bind(m.id).all<any>()).results
  const byDay = new Map<string, { kcal: number; protein: number; cost: number; complete: boolean }>(), repeats = new Map<string, number>(), notes: string[] = []
  for (const it of items) {
    const calc = await recipeCalc(c.env, a.orgId!, it.recipe_id)
    if (!calc) continue
    const d = byDay.get(it.date ?? 'sem_data') ?? { kcal: 0, protein: 0, cost: 0, complete: true }
    d.kcal += calc.nutrition_per_portion.energy_kcal; d.protein += calc.nutrition_per_portion.protein_g
    if (calc.cost_complete) d.cost += calc.cost_per_portion; else d.complete = false
    byDay.set(it.date ?? 'sem_data', d)
    repeats.set(it.recipe_id, (repeats.get(it.recipe_id) ?? 0) + 1)
    if (!calc.nutrition_complete) notes.push(`Receita ${it.recipe_id}: composição nutricional incompleta`)
  }
  const days = [...byDay.entries()].map(([date, v]) => ({ date, kcal: round(v.kcal, 0), protein_g: round(v.protein, 1), cost: v.complete ? round(v.cost, 2) : null }))
  const rep = [...repeats.entries()].filter(([, n]) => n >= 3).map(([recipe_id, n]) => ({ recipe_id, times: n }))
  const target = Number(b.target_kcal_per_day) > 0 ? Number(b.target_kcal_per_day) : null
  const flags = target ? days.filter((d) => Math.abs(d.kcal - target) / target > 0.15).map((d) => ({ date: d.date, message: `Energia do dia (${d.kcal} kcal) difere mais de 15% da meta informada (${target} kcal)` })) : []
  const payload = { menu_id: m.id, days, frequent_repeats: rep, flags, notes, criteria: 'somas por dia das preparações do cardápio; meta de energia informada pelo usuário; repetição ≥ 3 vezes' }
  const id = await saveSuggestion(c, 'menu_review', payload)
  return c.json({ id, status: 'pending', ...payload, disclosure: DISCLOSURE, data_sent_externally: false }, 201)
})
ops.get('/ai/suggestions', need('ai.use'), async (c) => {
  await aiGate(c)
  const rows = (await c.env.DB.prepare('SELECT * FROM ai_suggestions WHERE org_id=? ORDER BY created_at DESC LIMIT 100').bind(c.get('auth').orgId).all<any>()).results
  return c.json({ items: rows.map((r) => ({ ...r, payload: parseJson(r.payload, {}) })) })
})
ops.post('/ai/suggestions/:id/review', need('ai.review'), async (c) => {
  await aiGate(c)
  const a = c.get('auth'), b = await readBody(c)
  const r = await c.env.DB.prepare('SELECT * FROM ai_suggestions WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!r) throw notFound('Sugestão')
  if (r.status !== 'pending') throw conflict('already_reviewed', 'Sugestão já revisada')
  if (!['accepted', 'rejected'].includes(b.decision)) throw bad('invalid_field', "decision: 'accepted' | 'rejected'")
  await c.env.DB.prepare('UPDATE ai_suggestions SET status=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?').bind(b.decision, a.userId, nowIso(), nowIso(), r.id).run()
  await audit(c, 'review', 'ai_suggestions', r.id, { decision: b.decision })
  return c.json({ ok: true, note: 'O aceite registra a validação humana; a alteração em si deve ser feita manualmente no módulo correspondente.' })
})

// ================= portal do paciente/atleta =================
async function portalSubject(c: AppCtx) {
  const a = c.get('auth')
  if (!can(a, 'portal.self')) throw forbidden()
  const ath = await c.env.DB.prepare('SELECT * FROM athletes WHERE org_id=? AND user_id=?').bind(a.orgId, a.userId).first<any>()
  if (ath) return { type: 'athlete' as const, row: ath }
  const pat = await c.env.DB.prepare('SELECT * FROM patients WHERE org_id=? AND user_id=?').bind(a.orgId, a.userId).first<any>()
  if (pat) return { type: 'patient' as const, row: pat }
  throw notFound('Cadastro vinculado ao seu usuário')
}
ops.get('/portal/me', need('portal.self'), async (c) => {
  const a = c.get('auth'), s = await portalSubject(c)
  const base: any = { type: s.type, name: s.row.name }
  const plan = await c.env.DB.prepare("SELECT id,name,valid_from,valid_to FROM meal_plans WHERE org_id=? AND subject_type=? AND subject_id=? AND status='approved' ORDER BY approved_at DESC LIMIT 1").bind(a.orgId, s.type, s.row.id).first<any>()
  base.approved_plan = plan ?? null
  base.goals = (await c.env.DB.prepare('SELECT metric,target,current,start_value,status,due_date FROM goals WHERE org_id=? AND subject_type=? AND subject_id=?').bind(a.orgId, s.type, s.row.id).all()).results
  base.upcoming_appointments = (await c.env.DB.prepare("SELECT id,title,starts_at FROM events WHERE org_id=? AND status='scheduled' AND starts_at>=? AND related_type=? AND related_id=? ORDER BY starts_at LIMIT 20").bind(a.orgId, nowIso(), s.type, s.row.id).all()).results
  if (s.type === 'patient') base.today_meals = (await c.env.DB.prepare("SELECT o.meal_type,o.status,o.scheduled_time,r.name AS preparation FROM meal_orders o LEFT JOIN recipes r ON r.id=o.recipe_id WHERE o.org_id=? AND o.patient_id=? AND o.date=? AND o.status<>'cancelled' ORDER BY o.meal_type").bind(a.orgId, s.row.id, today()).all()).results
  await audit(c, 'read', 'portal', s.row.id)
  return c.json(base)
})
ops.get('/portal/diary', need('portal.self'), async (c) => {
  const a = c.get('auth'), s = await portalSubject(c)
  return c.json({ items: (await c.env.DB.prepare('SELECT id,date,meal_name,description FROM food_diary WHERE org_id=? AND subject_type=? AND subject_id=? ORDER BY date DESC LIMIT 100').bind(a.orgId, s.type, s.row.id).all()).results })
})
ops.post('/portal/diary', need('portal.self'), async (c) => {
  const a = c.get('auth'), s = await portalSubject(c), b = await readBody(c)
  if (!String(b.meal_name ?? '').trim() || !String(b.description ?? '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) throw bad('invalid_field', 'Informe date, meal_name e description')
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO food_diary (id,org_id,unit_id,subject_type,subject_id,date,meal_name,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id, a.orgId, s.row.unit_id ?? null, s.type, s.row.id, b.date, String(b.meal_name).slice(0, 80), String(b.description).slice(0, 1000), a.userId, ts, ts).run()
  await audit(c, 'create', 'food_diary', id, { via: 'portal' })
  return c.json({ id }, 201)
})
export { decryptValue }

import { Hono } from 'hono'
import { type AppEnv, assertCan, audit, requireUnit } from '../lib/auth'
import { decryptValue } from '../lib/crypto'
import { bad, nowIso, notFound, uid } from '../lib/util'
import { guardSubject } from '../lib/subject'

/** Direitos do titular (LGPD art. 18): exportar, anonimizar e apagar. Toda solicitação fica registrada. */
export const lgpd = new Hono<AppEnv>()
const TABLE = { athlete: 'athletes', patient: 'patients' } as const
const ENC = /^v1\.[^.]+\.[^.]+$/

async function plain(c: any, table: string, row: any) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' && ENC.test(v) ? await decryptValue(c.env, v, `${table}.${k}.${row.id}`) : v
  return out
}
async function record(c: any, subject_type: string, subject_id: string, kind: string, note?: string) {
  const a = c.get('auth'), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO lgpd_requests (id,org_id,subject_type,subject_id,kind,status,note,requested_by,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(uid(), a.orgId, subject_type, subject_id, kind, 'done', note ?? null, a.userId, ts, ts).run()
}

lgpd.get('/lgpd/requests', async (c) => {
  assertCan(c.get('auth'), 'lgpd.manage')
  return c.json({ items: (await c.env.DB.prepare('SELECT * FROM lgpd_requests WHERE org_id=? ORDER BY created_at DESC LIMIT 200').bind(c.get('auth').orgId).all()).results })
})

/** Portabilidade/acesso: todos os dados do titular, já decifrados, em JSON. */
lgpd.get('/lgpd/subjects/:type/:id/export', async (c) => {
  assertCan(c.get('auth'), 'lgpd.manage')
  const s = await guardSubject(c, c.req.param('type'), c.req.param('id'), 'read')
  const a = c.get('auth'), t = TABLE[s.type], id = s.id
  const q = async (sql: string, ...p: unknown[]) => (await c.env.DB.prepare(sql).bind(...p).all<any>()).results
  const bundle: Record<string, unknown> = {
    generated_at: nowIso(), subject_type: s.type, subject: await plain(c, t, s.row),
    assessments: await q('SELECT * FROM assessments WHERE org_id=? AND subject_type=? AND subject_id=?', a.orgId, s.type, id),
    meal_plans: await q('SELECT * FROM meal_plans WHERE org_id=? AND subject_type=? AND subject_id=?', a.orgId, s.type, id),
    goals: await q('SELECT * FROM goals WHERE org_id=? AND subject_type=? AND subject_id=?', a.orgId, s.type, id),
    documents: await q('SELECT id,title,kind,mime,size,created_at FROM documents WHERE org_id=? AND related_type=? AND related_id=?', a.orgId, t, id)
  }
  if (s.type === 'patient') {
    bundle.diet_prescriptions = await q('SELECT * FROM diet_prescriptions WHERE org_id=? AND patient_id=?', a.orgId, id)
    bundle.meal_orders = await q('SELECT id,date,meal_type,status,conflict_level FROM meal_orders WHERE org_id=? AND patient_id=?', a.orgId, id)
  } else bundle.supplements = await q('SELECT * FROM supplements WHERE org_id=? AND subject_type=? AND subject_id=?', a.orgId, s.type, id)
  await record(c, s.type, id, 'export')
  await audit(c, 'lgpd_export', t, id, {})
  return new Response(JSON.stringify(bundle, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="titular-${id.slice(0, 8)}.json"`, 'Cache-Control': 'private, no-store' } })
})

/** Anonimização: remove identificadores e texto livre; mantém medidas sem vínculo com a pessoa. Irreversível. */
lgpd.post('/lgpd/subjects/:type/:id/anonymize', async (c) => {
  assertCan(c.get('auth'), 'lgpd.manage')
  const s = await guardSubject(c, c.req.param('type'), c.req.param('id'), 'write')
  const d = await c.req.json().catch(() => ({})) as any
  if (d.confirm !== true) throw bad('confirm_required', 'Confirme a anonimização (irreversível) com confirm:true')
  if (!d.reason || String(d.reason).length < 5) throw bad('reason_required', 'Informe o motivo/base da solicitação')
  const a = c.get('auth'), t = TABLE[s.type], id = s.id, ts = nowIso()
  if (s.row.anonymized_at) throw bad('already_anonymized', 'Registro já anonimizado')
  if (s.type === 'patient' && s.row.status === 'admitted') throw bad('patient_admitted', 'Paciente internado: dê alta antes de anonimizar')
  const stmts = [
    s.type === 'patient'
      ? c.env.DB.prepare("UPDATE patients SET name='Paciente anonimizado', internal_code=?, birth_date=NULL, user_id=NULL, diagnoses=NULL, allergies=NULL, intolerances=NULL, restrictions=NULL, nutritional_needs=NULL, nutritional_risk=NULL, anonymized_at=?, updated_at=? WHERE id=? AND org_id=?").bind('ANON-' + id.slice(0, 8), ts, ts, id, a.orgId)
      : c.env.DB.prepare("UPDATE athletes SET name='Atleta anonimizado', birth_date=NULL, user_id=NULL, goals=NULL, clinical_history=NULL, medications=NULL, allergies=NULL, restrictions=NULL, active=0, anonymized_at=?, updated_at=? WHERE id=? AND org_id=?").bind(ts, ts, id, a.orgId),
    c.env.DB.prepare('DELETE FROM document_chunks WHERE doc_id IN (SELECT id FROM documents WHERE org_id=? AND related_type=? AND related_id=?)').bind(a.orgId, t, id),
    c.env.DB.prepare('DELETE FROM documents WHERE org_id=? AND related_type=? AND related_id=?').bind(a.orgId, t, id),
    c.env.DB.prepare('DELETE FROM food_diary WHERE org_id=? AND subject_type=? AND subject_id=?').bind(a.orgId, s.type, id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(s.row.user_id ?? '-')
  ]
  await c.env.DB.batch(stmts)
  await record(c, s.type, id, 'anonymize', String(d.reason))
  await audit(c, 'lgpd_anonymize', t, id, { reason: String(d.reason) })
  return c.json({ ok: true, anonymized_at: ts })
})

/** Apaga o registro de restrições de um hóspede (revogação de consentimento). */
lgpd.delete('/lgpd/guests/:id', async (c) => {
  assertCan(c.get('auth'), 'lgpd.manage')
  const r = await c.env.DB.prepare('SELECT id, unit_id FROM guest_restrictions WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).first<any>()
  if (!r) throw notFound('Registro')
  await requireUnit(c, 'lgpd.manage', r.unit_id)
  await c.env.DB.prepare('DELETE FROM guest_restrictions WHERE id=?').bind(r.id).run()
  await record(c, 'guest', r.id, 'erase')
  await audit(c, 'lgpd_erase', 'guest_restrictions', r.id, {})
  return c.json({ ok: true })
})

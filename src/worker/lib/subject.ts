import type { Hono } from 'hono'
import { type AppCtx, type AppEnv, assertCan, audit, can, needAny } from './auth'
import { type Res, serializeRow, toDb, validate } from './crud'
import { bad, forbidden, nowIso, notFound, readBody, uid } from './util'

export type SubjectType = 'athlete' | 'patient'
export interface Subject { type: SubjectType; id: string; unit_id: string | null; row: any }

const TABLE: Record<SubjectType, string> = { athlete: 'athletes', patient: 'patients' }
const PERM: Record<SubjectType, { read: string; write: string }> = {
  athlete: { read: 'sports.read', write: 'sports.write' },
  patient: { read: 'clinical.read', write: 'clinical.write' }
}

/** Carrega o sujeito (atleta/paciente) da organização e confere a permissão para a unidade dele. */
export async function guardSubject(c: AppCtx, type: unknown, id: unknown, mode: 'read' | 'write'): Promise<Subject> {
  if (type !== 'athlete' && type !== 'patient') throw bad('invalid_subject', "subject_type deve ser 'athlete' ou 'patient'")
  const a = c.get('auth')
  const row = await c.env.DB.prepare(`SELECT * FROM ${TABLE[type]} WHERE id=? AND org_id=?`).bind(String(id ?? ''), a.orgId).first<any>()
  const perm = PERM[type][mode]
  if (!row || !can(a, perm, row.unit_id)) throw notFound(type === 'athlete' ? 'Atleta' : 'Paciente')
  return { type, id: row.id, unit_id: row.unit_id ?? null, row }
}

/** CRUD para tabelas ligadas a um sujeito (subject_type + subject_id). A unidade é herdada do sujeito. */
export function mountSubjectCrud(
  app: Hono<AppEnv>, res: Res,
  hooks: { beforeWrite?: (c: AppCtx, data: Record<string, any>, subject: Subject, existing: any | null, id: string) => Promise<void> | void } = {}
) {
  const base = `/${res.path}`
  const perms = ['sports.read', 'clinical.read']
  const permsW = ['sports.write', 'clinical.write']
  const outRow = async (c: AppCtx, r: any) => ({ ...(await serializeRow(c.env, res, r)), subject_type: r.subject_type, subject_id: r.subject_id })

  app.get(base, needAny(...perms), async (c) => {
    const q = new URL(c.req.url).searchParams
    const s = await guardSubject(c, q.get('subject_type'), q.get('subject_id'), 'read')
    const rows = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE org_id=? AND subject_type=? AND subject_id=? ORDER BY ${res.order ?? 'created_at DESC'} LIMIT 500`).bind(c.get('auth').orgId, s.type, s.id).all<any>()
    if (res.auditRead) await audit(c, 'list', res.table, s.id, { count: rows.results.length })
    return c.json({ items: await Promise.all(rows.results.map((r) => outRow(c, r))) })
  })
  app.get(`${base}/:id`, needAny(...perms), async (c) => {
    const r = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=? AND org_id=?`).bind(c.req.param('id'), c.get('auth').orgId).first<any>()
    if (!r) throw notFound()
    await guardSubject(c, r.subject_type, r.subject_id, 'read')
    if (res.auditRead) await audit(c, 'read', res.table, r.id)
    return c.json(await outRow(c, r))
  })
  app.post(base, needAny(...permsW), async (c) => {
    const a = c.get('auth'), body = await readBody(c)
    const s = await guardSubject(c, body.subject_type, body.subject_id, 'write')
    const data = await validate(c, { ...res, unit: false }, body, false)
    const id = uid()
    await hooks.beforeWrite?.(c, data, s, null, id)
    const cols = ['id', 'org_id', 'unit_id', 'subject_type', 'subject_id', ...Object.keys(data), 'created_at', 'updated_at']
    const vals: unknown[] = [id, a.orgId, s.unit_id, s.type, s.id]
    for (const k of Object.keys(data)) {
      const fd = res.fields.find((x) => x.n === k)
      vals.push(fd ? await toDb(c.env, res, id, fd, data[k]) : data[k])
    }
    const ts = nowIso()
    await c.env.DB.prepare(`INSERT INTO ${res.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...vals, ts, ts).run()
    await audit(c, 'create', res.table, id, { fields: Object.keys(data), subject_type: s.type })
    return c.json(await outRow(c, await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=?`).bind(id).first()), 201)
  })
  app.put(`${base}/:id`, needAny(...permsW), async (c) => {
    const a = c.get('auth')
    const ex = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=? AND org_id=?`).bind(c.req.param('id'), a.orgId).first<any>()
    if (!ex) throw notFound()
    const s = await guardSubject(c, ex.subject_type, ex.subject_id, 'write')
    const data = await validate(c, { ...res, unit: false }, await readBody(c), true)
    await hooks.beforeWrite?.(c, data, s, ex, ex.id)
    const keys = Object.keys(data)
    if (keys.length) {
      const vals: unknown[] = []
      for (const k of keys) { const fd = res.fields.find((x) => x.n === k); vals.push(fd ? await toDb(c.env, res, ex.id, fd, data[k]) : data[k]) }
      await c.env.DB.prepare(`UPDATE ${res.table} SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).bind(...vals, nowIso(), ex.id).run()
    }
    await audit(c, 'update', res.table, ex.id, { fields: keys })
    return c.json(await outRow(c, await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=?`).bind(ex.id).first()))
  })
  app.delete(`${base}/:id`, needAny(...permsW), async (c) => {
    const ex = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=? AND org_id=?`).bind(c.req.param('id'), c.get('auth').orgId).first<any>()
    if (!ex) throw notFound()
    await guardSubject(c, ex.subject_type, ex.subject_id, 'write')
    await c.env.DB.prepare(`DELETE FROM ${res.table} WHERE id=?`).bind(ex.id).run()
    await audit(c, 'delete', res.table, ex.id)
    return c.json({ ok: true })
  })
}
export { assertCan, forbidden }

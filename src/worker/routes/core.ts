import { Hono } from 'hono'
import { type AppCtx, type AppEnv, audit, can, need, needAny, needPlatformAdmin, hasOrgWide, unitScope, type AuthCtx } from '../lib/auth'
import { f, mountCrud } from '../lib/crud'
import { ALL_PERMS, MODULES } from '../lib/rbac'
import { b64, hashPassword, randomToken, sha256Hex, unb64 } from '../lib/crypto'
import { HttpError, bad, conflict, csvEscape, forbidden, nowIso, notFound, parseJson, readBody, toCsv, uid } from '../lib/util'
import { validatePassword } from './auth'
import { encryptValue } from '../lib/crypto'
import { getContent, maxDocBytes, putContent, removeContent } from '../lib/docs'
import { deliver } from '../lib/outbound'
import { buildPdf, pdfResponse } from '../lib/pdf'

export const core = new Hono<AppEnv>()

const UNIT_KINDS = ['generic', 'clinic', 'hospital', 'uan', 'refeitorio', 'cozinha', 'restaurant', 'hotel', 'resort', 'kitchen_central', 'kitchen_satellite',
  'buffet', 'bar', 'room_service', 'outlet', 'staff_dining'] as const

async function countOf(c: AppCtx, sql: string, ...p: unknown[]): Promise<number> {
  return (await c.env.DB.prepare(sql).bind(...p).first<any>())?.n ?? 0
}
async function enforceLimit(c: any, key: string, current: number) {
  const lim = c.get('auth').org?.limits?.[key]
  if (typeof lim === 'number' && lim > 0 && current >= lim)
    throw new HttpError(402, 'plan_limit', `Limite do plano atingido (${key}=${lim}). Altere o plano no painel administrativo.`)
}

// ---------- organização ----------
core.get('/org', need('notifications.read'), async (c) => {
  const a = c.get('auth')
  const o = await c.env.DB.prepare('SELECT id,name,kind,ai_enabled,require_mfa,billing_status,settings FROM organizations WHERE id=?').bind(a.orgId).first<any>()
  return c.json({ ...o, ai_enabled: !!o.ai_enabled, require_mfa: !!o.require_mfa, settings: parseJson(o.settings, {}), plan: a.org?.planKey, modules: [...a.modules], limits: a.org?.limits })
})
core.put('/org', need('org.manage'), async (c) => {
  const b = await readBody(c)
  const sets: string[] = [], vals: unknown[] = []
  if (typeof b.name === 'string' && b.name.trim()) { sets.push('name=?'); vals.push(b.name.trim().slice(0, 120)) }
  if ('ai_enabled' in b) { sets.push('ai_enabled=?'); vals.push(b.ai_enabled ? 1 : 0) }
  if ('require_mfa' in b) { sets.push('require_mfa=?'); vals.push(b.require_mfa ? 1 : 0) }
  if (b.settings && typeof b.settings === 'object') { sets.push('settings=?'); vals.push(JSON.stringify(b.settings).slice(0, 20000)) }
  if (!sets.length) throw bad('nothing_to_update', 'Nada para atualizar')
  await c.env.DB.prepare(`UPDATE organizations SET ${sets.join(',')}, updated_at=? WHERE id=?`).bind(...vals, nowIso(), c.get('auth').orgId).run()
  await audit(c, 'update', 'organizations', c.get('auth').orgId!, { fields: Object.keys(b) })
  return c.json({ ok: true })
})

// ---------- estrutura ----------
mountCrud(core, {
  table: 'units', path: 'units', read: 'notifications.read', write: 'units.manage', unit: false, order: 'name ASC',
  fields: [f.s('name', { req: true, max: 120 }), f.s('kind', { enum: UNIT_KINDS }), f.s('parent_unit_id', { ref: 'units', max: 64 }), f.b('active')],
  hooks: {
    async beforeWrite(c, data, existing, id) {
      if (!existing) await enforceLimit(c, 'max_units', await countOf(c, 'SELECT COUNT(*) AS n FROM units WHERE org_id=?', c.get('auth').orgId))
      if (data.parent_unit_id) {
        if (data.parent_unit_id === id) throw bad('invalid_parent', 'Unidade não pode ser pai de si mesma')
        // evita ciclos
        let cur: string | null = data.parent_unit_id
        for (let i = 0; cur && i < 20; i++) {
          if (cur === id) throw bad('invalid_parent', 'Hierarquia cíclica')
          cur = (await c.env.DB.prepare('SELECT parent_unit_id FROM units WHERE id=?').bind(cur).first<any>())?.parent_unit_id ?? null
        }
      }
    },
    async beforeDelete(c, row) {
      const a = c.get('auth')
      if (await countOf(c, 'SELECT COUNT(*) AS n FROM units WHERE parent_unit_id=? AND org_id=?', row.id, a.orgId)) throw conflict('has_children', 'Unidade possui unidades filhas')
      if (await countOf(c, 'SELECT COUNT(*) AS n FROM memberships WHERE unit_id=? AND org_id=?', row.id, a.orgId)) throw conflict('has_members', 'Unidade possui usuários vinculados')
    }
  }
})
mountCrud(core, { table: 'departments', path: 'departments', read: 'notifications.read', write: 'units.manage', unit: 'loose', order: 'name ASC', fields: [f.s('name', { req: true, max: 120 })] })
mountCrud(core, { table: 'teams', path: 'teams', read: 'notifications.read', write: 'units.manage', unit: 'loose', order: 'name ASC', fields: [f.s('name', { req: true, max: 120 }), f.j('member_ids')] })
mountCrud(core, { table: 'job_titles', path: 'job-titles', read: 'notifications.read', write: 'users.manage', unit: false, order: 'name ASC', fields: [f.s('name', { req: true, max: 120 })] })
mountCrud(core, {
  table: 'professionals', path: 'professionals', read: 'docs.read', write: 'users.manage', unit: false, order: 'display_name ASC',
  fields: [f.s('user_id', { req: true, ref: 'users', max: 64 }), f.s('council', { max: 40 }), f.s('council_number', { max: 40 }), f.s('specialty', { max: 120 }), f.s('display_name', { max: 160 }), f.s('notes')]
})

// ---------- papéis ----------
const SELF_SERVICE = new Set(['portal.self'])
const actorHolds = (a: AuthCtx, perms: string[]) => perms.every((p) => SELF_SERVICE.has(p) || a.memberships.some((m) => m.perms.has(p)))
function cleanPerms(v: unknown): string[] {
  if (!Array.isArray(v)) throw bad('invalid_field', 'permissions deve ser lista')
  const out = [...new Set(v.map(String))]
  for (const p of out) if (!(ALL_PERMS as readonly string[]).includes(p)) throw bad('invalid_permission', `Permissão desconhecida: ${p}`)
  return out
}
core.get('/permissions', need('roles.manage'), (c) => c.json({ permissions: ALL_PERMS, modules: MODULES }))
core.get('/roles', needAny('roles.manage', 'users.manage'), async (c) => {
  const r = await c.env.DB.prepare('SELECT id,key,name,permissions,is_system FROM roles WHERE org_id=? ORDER BY name').bind(c.get('auth').orgId).all<any>()
  return c.json({ items: r.results.map((x) => ({ ...x, permissions: parseJson(x.permissions, []), is_system: !!x.is_system })) })
})
core.post('/roles', need('roles.manage'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const key = String(b.key ?? '').trim()
  if (!/^[a-z0-9_]{3,40}$/.test(key) || !String(b.name ?? '').trim()) throw bad('invalid_field', 'key (a-z0-9_) e name são obrigatórios')
  const perms = cleanPerms(b.permissions ?? [])
  if (!actorHolds(a, perms)) throw forbidden('Você não pode conceder permissões que não possui')
  if (await c.env.DB.prepare('SELECT 1 FROM roles WHERE org_id=? AND key=?').bind(a.orgId, key).first()) throw conflict('role_exists', 'Papel já existe')
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO roles (id,org_id,key,name,permissions,is_system,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').bind(id, a.orgId, key, String(b.name).slice(0, 80), JSON.stringify(perms), ts, ts).run()
  await audit(c, 'create', 'roles', id, { key })
  return c.json({ id, key, name: b.name, permissions: perms }, 201)
})
core.put('/roles/:id', need('roles.manage'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const r = await c.env.DB.prepare('SELECT * FROM roles WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!r) throw notFound('Papel')
  if (r.key === 'administrador') throw forbidden('O papel Administrador não pode ser alterado')
  const perms = b.permissions !== undefined ? cleanPerms(b.permissions) : parseJson<string[]>(r.permissions, [])
  if (b.permissions !== undefined && !actorHolds(a, perms)) throw forbidden('Você não pode conceder permissões que não possui')
  await c.env.DB.prepare('UPDATE roles SET name=?, permissions=?, updated_at=? WHERE id=?').bind(b.name ? String(b.name).slice(0, 80) : r.name, JSON.stringify(perms), nowIso(), r.id).run()
  await audit(c, 'update', 'roles', r.id, { permissions_changed: b.permissions !== undefined })
  return c.json({ ok: true })
})
core.delete('/roles/:id', need('roles.manage'), async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('SELECT * FROM roles WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!r) throw notFound('Papel')
  if (r.is_system) throw forbidden('Papéis do sistema não podem ser removidos')
  if (await countOf(c, 'SELECT COUNT(*) AS n FROM memberships WHERE role_id=? AND org_id=?', r.id, a.orgId)) throw conflict('role_in_use', 'Papel em uso')
  await c.env.DB.prepare('DELETE FROM roles WHERE id=?').bind(r.id).run()
  await audit(c, 'delete', 'roles', r.id)
  return c.json({ ok: true })
})

// ---------- usuários e vínculos (um usuário pode ter vários papéis) ----------
async function roleOr400(c: AppCtx, roleId: unknown) {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('SELECT * FROM roles WHERE id=? AND org_id=?').bind(String(roleId ?? ''), a.orgId).first<any>()
  if (!r) throw bad('invalid_role', 'Papel inválido')
  if (!actorHolds(a, parseJson<string[]>(r.permissions, []))) throw forbidden('Você não pode atribuir um papel com permissões que não possui')
  return r
}
async function unitOr400(c: any, unitId: unknown) {
  if (unitId === null || unitId === undefined || unitId === '') return null
  const u = await c.env.DB.prepare('SELECT id FROM units WHERE id=? AND org_id=?').bind(String(unitId), c.get('auth').orgId).first()
  if (!u) throw bad('invalid_unit', 'Unidade inválida')
  return String(unitId)
}
core.get('/users', need('users.manage'), async (c) => {
  const a = c.get('auth')
  const rows = (await c.env.DB.prepare(
    `SELECT u.id,u.email,u.name,u.mfa_enabled,u.active,m.id AS membership_id,m.unit_id,m.active AS m_active,r.key AS role_key,r.name AS role_name,m.role_id
     FROM memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id WHERE m.org_id=? ORDER BY u.name`
  ).bind(a.orgId).all<any>()).results
  const map = new Map<string, any>()
  for (const r of rows) {
    if (!map.has(r.id)) map.set(r.id, { id: r.id, email: r.email, name: r.name, mfa_enabled: !!r.mfa_enabled, active: !!r.active, memberships: [] })
    map.get(r.id).memberships.push({ id: r.membership_id, role_id: r.role_id, role_key: r.role_key, role_name: r.role_name, unit_id: r.unit_id, active: !!r.m_active })
  }
  return c.json({ items: [...map.values()] })
})
core.post('/users', need('users.manage'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const email = String(b.email ?? '').toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('invalid_email', 'E-mail inválido')
  const role = await roleOr400(c, b.role_id)
  const unitId = await unitOr400(c, b.unit_id)
  let user = await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first<any>()
  const ts = nowIso()
  if (user && (await c.env.DB.prepare('SELECT 1 FROM memberships WHERE user_id=? AND org_id=? AND role_id=? AND IFNULL(unit_id,"")=?').bind(user.id, a.orgId, role.id, unitId ?? '').first()))
    throw conflict('membership_exists', 'Vínculo já existe')
  const isNewMember = !(await c.env.DB.prepare('SELECT 1 FROM memberships WHERE user_id=? AND org_id=?').bind(user?.id ?? '', a.orgId).first())
  if (isNewMember) await enforceLimit(c, 'max_users', await countOf(c, 'SELECT COUNT(DISTINCT user_id) AS n FROM memberships WHERE org_id=? AND active=1', a.orgId))
  if (!user) {
    const name = String(b.name ?? '').trim()
    if (!name) throw bad('missing_field', 'Informe o nome')
    const pw = await hashPassword(validatePassword(b.password))
    const id = uid()
    await c.env.DB.prepare('INSERT INTO users (id,email,name,password_hash,salt,iterations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, email, name.slice(0, 120), pw.hash, pw.salt, pw.iterations, ts, ts).run()
    user = { id }
  }
  const mid = uid()
  await c.env.DB.prepare('INSERT INTO memberships (id,org_id,user_id,role_id,unit_id,job_title_id,department_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(mid, a.orgId, user.id, role.id, unitId, b.job_title_id ?? null, b.department_id ?? null, ts, ts).run()
  await audit(c, 'create', 'memberships', mid, { role: role.key, user_id: user.id })
  return c.json({ user_id: user.id, membership_id: mid }, 201)
})
async function lastAdminGuard(c: AppCtx, membershipId: string) {
  const a = c.get('auth')
  const adm = await c.env.DB.prepare("SELECT id FROM roles WHERE org_id=? AND key='administrador'").bind(a.orgId).first<any>()
  const m = await c.env.DB.prepare('SELECT role_id FROM memberships WHERE id=? AND org_id=?').bind(membershipId, a.orgId).first<any>()
  if (adm && m?.role_id === adm.id && (await countOf(c, 'SELECT COUNT(*) AS n FROM memberships WHERE org_id=? AND role_id=? AND active=1', a.orgId, adm.id)) <= 1)
    throw conflict('last_admin', 'Não é possível remover o último administrador')
}
core.put('/memberships/:id', need('users.manage'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const m = await c.env.DB.prepare('SELECT * FROM memberships WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!m) throw notFound('Vínculo')
  const role = b.role_id ? await roleOr400(c, b.role_id) : null
  const unit = 'unit_id' in b ? await unitOr400(c, b.unit_id) : m.unit_id
  const active = 'active' in b ? (b.active ? 1 : 0) : m.active
  if (!active || (role && role.id !== m.role_id)) await lastAdminGuard(c, m.id)
  await c.env.DB.prepare('UPDATE memberships SET role_id=?, unit_id=?, active=?, updated_at=? WHERE id=?').bind(role?.id ?? m.role_id, unit, active, nowIso(), m.id).run()
  await audit(c, 'update', 'memberships', m.id, { role_changed: !!role, active })
  return c.json({ ok: true })
})
core.delete('/memberships/:id', need('users.manage'), async (c) => {
  const a = c.get('auth')
  const m = await c.env.DB.prepare('SELECT id FROM memberships WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!m) throw notFound('Vínculo')
  await lastAdminGuard(c, m.id)
  await c.env.DB.prepare('DELETE FROM memberships WHERE id=?').bind(m.id).run()
  await audit(c, 'delete', 'memberships', m.id)
  return c.json({ ok: true })
})

// ---------- convites (o token é exibido uma única vez; o envio por e-mail não está implementado) ----------
core.post('/invitations', need('users.manage'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const email = String(b.email ?? '').toLowerCase().trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('invalid_email', 'E-mail inválido')
  const role = await roleOr400(c, b.role_id)
  const unitId = await unitOr400(c, b.unit_id)
  const token = randomToken(24), id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO invitations (id,org_id,email,role_id,unit_id,token_hash,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, email, role.id, unitId, await sha256Hex(token), new Date(Date.now() + 7 * 86400_000).toISOString(), a.userId, ts, ts).run()
  await audit(c, 'create', 'invitations', id, { role: role.key })
  return c.json({ id, token, expires_in_days: 7, note: 'Entregue o token ao convidado por canal seguro. O envio automático por e-mail não está configurado.' }, 201)
})
core.get('/invitations', need('users.manage'), async (c) => {
  const r = await c.env.DB.prepare('SELECT id,email,role_id,unit_id,expires_at,accepted_at,created_at FROM invitations WHERE org_id=? ORDER BY created_at DESC LIMIT 200').bind(c.get('auth').orgId).all()
  return c.json({ items: r.results })
})
core.delete('/invitations/:id', need('users.manage'), async (c) => {
  await c.env.DB.prepare('DELETE FROM invitations WHERE id=? AND org_id=?').bind(c.req.param('id'), c.get('auth').orgId).run()
  return c.json({ ok: true })
})

// ---------- auditoria ----------
core.get('/audit', need('audit.read'), async (c) => {
  const q = new URL(c.req.url).searchParams
  const where = ['org_id=?'], params: unknown[] = [c.get('auth').orgId]
  for (const k of ['action', 'entity', 'user_id', 'entity_id']) if (q.get(k)) { where.push(`${k}=?`); params.push(q.get(k)) }
  if (q.get('from')) { where.push('ts>=?'); params.push(q.get('from')) }
  if (q.get('to')) { where.push('ts<=?'); params.push(q.get('to')) }
  const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 1000)
  const r = await c.env.DB.prepare(`SELECT id,user_id,action,entity,entity_id,meta,ip,ts FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).bind(...params, limit).all<any>()
  if (q.get('format') === 'pdf') {
    await audit(c, 'export', 'audit_log', undefined, { rows: r.results.length, format: 'pdf' })
    const bytes = await buildPdf({ title: 'Relatório de auditoria', landscape: true, subtitle: `${r.results.length} registros mais recentes${q.get('from') ? ' a partir de ' + q.get('from') : ''}`,
      blocks: [{ t: 'table', head: ['Data/hora (UTC)', 'Usuário', 'Ação', 'Entidade', 'ID', 'IP'], widths: [2, 2.4, 1.2, 1.6, 2.4, 1.4], rows: r.results.map((x: any) => [String(x.ts).slice(0, 19).replace('T', ' '), x.user_id ?? '', x.action, x.entity, x.entity_id ?? '', x.ip ?? '']) }] })
    return pdfResponse(bytes, 'auditoria.pdf')
  }
  if (q.get('format') === 'csv') {
    await audit(c, 'export', 'audit_log', undefined, { rows: r.results.length })
    return new Response(toCsv(r.results as any), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="auditoria.csv"', 'Cache-Control': 'no-store' } })
  }
  return c.json({ items: r.results.map((x) => ({ ...x, meta: parseJson(x.meta, {}) })) })
})

// ---------- notificações ----------
core.get('/notifications', need('notifications.read'), async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('SELECT id,title,body,kind,ref_type,ref_id,read_at,created_at FROM notifications WHERE org_id=? AND (user_id=? OR user_id IS NULL) ORDER BY created_at DESC LIMIT 100').bind(a.orgId, a.userId).all()
  return c.json({ items: r.results })
})
core.post('/notifications/:id/read', need('notifications.read'), async (c) => {
  const a = c.get('auth')
  await c.env.DB.prepare('UPDATE notifications SET read_at=? WHERE id=? AND org_id=? AND (user_id=? OR user_id IS NULL)').bind(nowIso(), c.req.param('id'), a.orgId, a.userId).run()
  return c.json({ ok: true })
})

// ---------- documentos privados (armazenados no D1; R2 é o caminho de evolução) ----------
const DOC_MIMES = ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv']
const CLINICAL_REL = ['patients', 'athletes', 'clinical_notes', 'exams', 'diet_prescriptions']
const QUALITY_REL = ['nonconformities', 'receiving_records', 'checklist_runs', 'temperature_logs']
function docAccess(a: AuthCtx, d: any): boolean {
  if (CLINICAL_REL.includes(d.related_type)) return can(a, d.related_type === 'athletes' ? 'sports.read' : 'clinical.read', d.unit_id)
  if (can(a, 'docs.read', d.unit_id)) return true
  if (QUALITY_REL.includes(d.related_type) && can(a, 'quality.read', d.unit_id)) return true
  return d.created_by === a.userId
}
core.post('/documents', needAny('docs.write', 'quality.write', 'clinical.write', 'sports.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const mime = String(b.mime ?? '')
  const content = String(b.content_b64 ?? '')
  if (!DOC_MIMES.includes(mime)) throw bad('invalid_mime', `Tipo não permitido. Aceitos: ${DOC_MIMES.join(', ')}`)
  const limit = maxDocBytes(c.env)
  if (!content || content.length > Math.ceil(limit * 4 / 3) + 8) throw bad('invalid_size', `Arquivo vazio ou maior que ${Math.floor(limit / 1048576)} MB`)
  let bytes: Uint8Array
  try { bytes = unb64(content) } catch { throw bad('invalid_base64', 'Conteúdo base64 inválido') }
  if (bytes.length > limit) throw bad('invalid_size', `Arquivo maior que ${Math.floor(limit / 1048576)} MB`)
  const unitId = b.unit_id ? String(b.unit_id) : null
  if (unitId && !(await c.env.DB.prepare('SELECT 1 FROM units WHERE id=? AND org_id=?').bind(unitId, a.orgId).first())) throw bad('invalid_unit', 'Unidade inválida')
  const rel = b.related_type ? String(b.related_type) : null
  if (rel && CLINICAL_REL.includes(rel) && !can(a, rel === 'athletes' ? 'sports.write' : 'clinical.write', unitId)) throw forbidden('Sem permissão para anexar a dados clínicos')
  const id = uid(), ts = nowIso()
  const st = await putContent(c.env, id, bytes)
  await c.env.DB.prepare('INSERT INTO documents (id,org_id,unit_id,kind,title,mime,size,content_b64,storage,chunk_count,related_type,related_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, a.orgId, unitId, String(b.kind ?? 'file').slice(0, 30), String(b.title ?? 'documento').slice(0, 160), mime, bytes.length, st.content_b64, st.storage, st.chunks, rel, b.related_id ? String(b.related_id) : null, a.userId, ts, ts).run()
  await audit(c, 'create', 'documents', id, { mime, size: bytes.length, related_type: rel, storage: st.storage })
  return c.json({ id, size: bytes.length, storage: st.storage }, 201)
})
core.get('/documents', needAny('docs.read', 'quality.read', 'clinical.read', 'sports.read'), async (c) => {
  const a = c.get('auth')
  const q = new URL(c.req.url).searchParams
  const rows = (await c.env.DB.prepare('SELECT id,unit_id,kind,title,mime,size,related_type,related_id,created_by,created_at FROM documents WHERE org_id=? ORDER BY created_at DESC LIMIT 500').bind(a.orgId).all<any>()).results
  const items = rows.filter((d) => docAccess(a, d) && (!q.get('related_type') || d.related_type === q.get('related_type')) && (!q.get('related_id') || d.related_id === q.get('related_id')))
  return c.json({ items })
})
core.get('/documents/:id/content', async (c) => {
  const a = c.get('auth')
  const d = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!d || !docAccess(a, d)) throw notFound('Documento')
  await audit(c, 'download', 'documents', d.id, { related_type: d.related_type })
  return new Response(await getContent(c.env, d), {
    headers: { 'Content-Type': d.mime, 'Content-Disposition': `attachment; filename="${String(d.title).replace(/[^\w.\-]+/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }
  })
})
core.delete('/documents/:id', needAny('docs.write', 'quality.write'), async (c) => {
  const a = c.get('auth')
  const d = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!d || !docAccess(a, d)) throw notFound('Documento')
  await removeContent(c.env, d)
  await c.env.DB.prepare('DELETE FROM documents WHERE id=?').bind(d.id).run()
  await audit(c, 'delete', 'documents', d.id)
  return c.json({ ok: true })
})
// Envio por e-mail: exige confirmação explícita; dados clínicos exigem base legal informada. Só vira 'sent' com 2xx do provedor.
core.post('/documents/:id/send-email', need('docs.write'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  if (b.confirm !== true) throw bad('confirmation_required', 'Envie confirm:true para confirmar o envio')
  const to = String(b.to ?? '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw bad('invalid_field', 'Destinatário inválido')
  const d = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!d || !docAccess(a, d)) throw notFound('Documento')
  const clinical = CLINICAL_REL.includes(d.related_type)
  if (clinical && !String(b.legal_basis ?? '').trim()) throw bad('legal_basis_required', 'Documento clínico: informe a base legal/finalidade (legal_basis) do compartilhamento')
  if (d.size > 7 * 1024 * 1024) throw bad('too_large', 'Documento grande demais para anexo de e-mail')
  const id = uid(), ts = nowIso()
  const bytes = await getContent(c.env, d)
  await c.env.DB.prepare("INSERT INTO outbound_messages (id,org_id,channel,to_addr,subject,body,payload,status,next_attempt_at,related_type,related_id,legal_basis,confirmed_by,created_by,created_at,updated_at) VALUES (?,?,'email',?,?,?,?,'queued',?,'documents',?,?,?,?,?,?)")
    .bind(id, a.orgId, to, String(b.subject ?? d.title).slice(0, 200), String(b.message ?? 'Segue documento em anexo.').slice(0, 2000),
      JSON.stringify({ attachments: [{ filename: String(d.title).replace(/[^\w.\-]+/g, '_'), content_b64: b64(bytes) }] }), ts, d.id, b.legal_basis ?? null, a.userId, a.userId, ts, ts).run()
  const r = await deliver(c.env, id)
  await audit(c, 'share', 'documents', d.id, { channel: 'email', outbox_id: id, status: r.status, clinical })
  if (r.status === 'not_configured') throw new HttpError(424, 'integration_not_configured', 'E-mail não configurado para esta organização. Nenhuma mensagem foi enviada.')
  if (!r.ok) throw new HttpError(502, 'delivery_failed', `O provedor recusou o envio: ${r.error}`, { outbox_id: id })
  return c.json({ ok: true, outbox_id: id, status: 'sent', provider: r.provider })
})

// ---------- painel da plataforma (planos e organizações) ----------
core.get('/admin/plans', needPlatformAdmin, async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM plans ORDER BY name').all<any>()
  return c.json({ items: r.results.map((p) => ({ ...p, modules: parseJson(p.modules, []), limits: parseJson(p.limits, {}), active: !!p.active })) })
})
core.post('/admin/plans', needPlatformAdmin, async (c) => {
  const b = await readBody(c)
  const key = String(b.key ?? '')
  if (!/^[a-z0-9_-]{2,40}$/.test(key) || !String(b.name ?? '').trim()) throw bad('invalid_field', 'key e name obrigatórios')
  const mods = (Array.isArray(b.modules) ? b.modules : []).map(String)
  for (const m of mods) if (!(MODULES as readonly string[]).includes(m)) throw bad('invalid_module', `Módulo inválido: ${m}`)
  const id = uid(), ts = nowIso()
  await c.env.DB.prepare('INSERT INTO plans (id,key,name,modules,limits,active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)').bind(id, key, String(b.name), JSON.stringify(mods), JSON.stringify(b.limits ?? {}), ts, ts).run()
  await audit(c, 'create', 'plans', id, { key })
  return c.json({ id }, 201)
})
core.put('/admin/plans/:id', needPlatformAdmin, async (c) => {
  const b = await readBody(c)
  const p = await c.env.DB.prepare('SELECT * FROM plans WHERE id=?').bind(c.req.param('id')).first<any>()
  if (!p) throw notFound('Plano')
  const mods = b.modules ? (b.modules as unknown[]).map(String) : parseJson<string[]>(p.modules, [])
  for (const m of mods) if (!(MODULES as readonly string[]).includes(m)) throw bad('invalid_module', `Módulo inválido: ${m}`)
  await c.env.DB.prepare('UPDATE plans SET name=?,modules=?,limits=?,active=?,updated_at=? WHERE id=?')
    .bind(b.name ?? p.name, JSON.stringify(mods), JSON.stringify(b.limits ?? parseJson(p.limits, {})), 'active' in b ? (b.active ? 1 : 0) : p.active, nowIso(), p.id).run()
  await audit(c, 'update', 'plans', p.id)
  return c.json({ ok: true })
})
core.get('/admin/organizations', needPlatformAdmin, async (c) => {
  const r = await c.env.DB.prepare('SELECT o.id,o.name,o.kind,o.billing_status,o.created_at,p.key AS plan FROM organizations o LEFT JOIN plans p ON p.id=o.plan_id ORDER BY o.created_at DESC LIMIT 500').all()
  return c.json({ items: r.results })
})
core.put('/admin/organizations/:id/plan', needPlatformAdmin, async (c) => {
  const b = await readBody(c)
  const p = await c.env.DB.prepare('SELECT id FROM plans WHERE key=?').bind(String(b.plan_key ?? '')).first<any>()
  if (!p) throw bad('invalid_plan', 'Plano inexistente')
  await c.env.DB.prepare('UPDATE organizations SET plan_id=?, billing_status=COALESCE(?,billing_status), updated_at=? WHERE id=?').bind(p.id, b.billing_status ?? null, nowIso(), c.req.param('id')).run()
  await audit(c, 'change_plan', 'organizations', c.req.param('id'), { plan_key: b.plan_key })
  return c.json({ ok: true })
})
export { csvEscape, b64, unitScope, hasOrgWide }

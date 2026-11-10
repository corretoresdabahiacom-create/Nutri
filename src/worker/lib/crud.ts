import { Hono } from 'hono'
import { type AppCtx, type AppEnv, audit, can, hasOrgWide, need, unitScope, assertCan } from './auth'
import { bad, forbidden, nowIso, notFound, parseJson, readBody, uid, type Env } from './util'
import { decryptValue, encryptValue } from './crypto'

export type FType = 's' | 'i' | 'r' | 'b' | 'j' | 'd' | 'ts'
export interface F {
  n: string
  t: FType
  req?: boolean
  enc?: boolean
  enum?: readonly string[]
  ref?: string
  max?: number
  /** somente leitura para o cliente (preenchido pelo servidor) */
  ro?: boolean
}
export const f = {
  s: (n: string, o: Partial<F> = {}): F => ({ n, t: 's', ...o }),
  i: (n: string, o: Partial<F> = {}): F => ({ n, t: 'i', ...o }),
  r: (n: string, o: Partial<F> = {}): F => ({ n, t: 'r', ...o }),
  b: (n: string, o: Partial<F> = {}): F => ({ n, t: 'b', ...o }),
  j: (n: string, o: Partial<F> = {}): F => ({ n, t: 'j', ...o }),
  d: (n: string, o: Partial<F> = {}): F => ({ n, t: 'd', ...o }),
  ts: (n: string, o: Partial<F> = {}): F => ({ n, t: 'ts', ...o })
}

export interface Res {
  table: string
  path: string
  fields: F[]
  read: string
  write: string
  del?: string | false
  /** a tabela possui unit_id. strict: linhas sem unidade só para escopo organizacional */
  unit?: false | 'loose' | 'strict'
  unitReq?: boolean
  filters?: string[]
  search?: string[]
  order?: string
  auditRead?: boolean
  hooks?: {
    beforeWrite?: (c: AppCtx, data: Record<string, any>, existing: Record<string, any> | null, id: string) => Promise<void> | void
    afterWrite?: (c: AppCtx, row: Record<string, any>, existing: Record<string, any> | null) => Promise<void> | void
    beforeDelete?: (c: AppCtx, row: Record<string, any>) => Promise<void> | void
    view?: (c: AppCtx, out: Record<string, any>) => Promise<Record<string, any>> | Record<string, any>
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const aad = (table: string, name: string, id: string) => `${table}.${name}.${id}`

async function refExists(c: AppCtx, table: string, id: string): Promise<boolean> {
  const orgId = c.get('auth').orgId!
  const db = c.env.DB
  if (table === 'foods') return !!(await db.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(id, orgId).first())
  if (table === 'users') return !!(await db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND org_id=?').bind(id, orgId).first())
  return !!(await db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND org_id=?`).bind(id, orgId).first())
}

function coerce(fd: F, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null
  switch (fd.t) {
    case 's': {
      if (typeof v !== 'string') throw bad('invalid_field', `Campo ${fd.n} deve ser texto`)
      if (v.length > (fd.max ?? 5000)) throw bad('invalid_field', `Campo ${fd.n} excede ${fd.max ?? 5000} caracteres`)
      if (fd.enum && !fd.enum.includes(v)) throw bad('invalid_field', `Campo ${fd.n} deve ser um de: ${fd.enum.join(', ')}`)
      return v
    }
    case 'i': {
      const n = Number(v)
      if (!Number.isInteger(n)) throw bad('invalid_field', `Campo ${fd.n} deve ser inteiro`)
      return n
    }
    case 'r': {
      const n = Number(v)
      if (!Number.isFinite(n)) throw bad('invalid_field', `Campo ${fd.n} deve ser numérico`)
      return n
    }
    case 'b':
      return v === true || v === 1 || v === 'true' || v === '1' ? 1 : 0
    case 'd':
      if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad('invalid_field', `Campo ${fd.n} deve ser data YYYY-MM-DD`)
      return v
    case 'ts':
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad('invalid_field', `Campo ${fd.n} deve ser data/hora ISO`)
      return v
    case 'j':
      if (JSON.stringify(v).length > 200_000) throw bad('invalid_field', `Campo ${fd.n} grande demais`)
      return v
  }
}

export async function toDb(env: Env, res: Res, id: string, fd: F, value: unknown): Promise<unknown> {
  if (value === null || value === undefined) return fd.t === 'j' && !fd.enc ? (fd.req ? '[]' : null) : null
  if (fd.enc) return encryptValue(env, value, aad(res.table, fd.n, id))
  if (fd.t === 'j') return JSON.stringify(value)
  return value
}

export async function fromDb(env: Env, res: Res, id: string, fd: F, raw: unknown): Promise<unknown> {
  if (raw === null || raw === undefined) return fd.t === 'j' ? (fd.enc ? null : null) : null
  if (fd.enc) return decryptValue(env, String(raw), aad(res.table, fd.n, id))
  if (fd.t === 'j') return parseJson(raw, null)
  if (fd.t === 'b') return !!raw
  return raw
}

export async function serializeRow(env: Env, res: Res, row: Record<string, any>) {
  const out: Record<string, any> = { id: row.id }
  if (res.unit) out.unit_id = row.unit_id ?? null
  for (const fd of res.fields) out[fd.n] = await fromDb(env, res, row.id, fd, row[fd.n])
  out.created_at = row.created_at
  out.updated_at = row.updated_at
  return out
}

function rowAccessible(c: AppCtx, perm: string, res: Res, row: Record<string, any>): boolean {
  const a = c.get('auth')
  if (!res.unit) return can(a, perm)
  if (row.unit_id) return can(a, perm, row.unit_id)
  return res.unit === 'strict' ? hasOrgWide(a, perm) && can(a, perm) : can(a, perm)
}

export async function loadRow(c: AppCtx, res: Res, id: string, perm = res.read) {
  const row = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=? AND org_id=?`).bind(id, c.get('auth').orgId).first<any>()
  // 404 (e não 403) para não revelar a existência de registros fora do escopo
  if (!row || !rowAccessible(c, perm, res, row)) throw notFound()
  return row
}

export async function validate(c: AppCtx, res: Res, body: Record<string, any>, partial: boolean) {
  const data: Record<string, any> = {}
  const fields = [...res.fields]
  if (res.unit) fields.unshift({ n: 'unit_id', t: 's', ref: 'units', req: !!res.unitReq, max: 64 })
  for (const fd of fields) {
    if (fd.ro) continue
    if (!(fd.n in body)) {
      if (!partial && fd.req) throw bad('missing_field', `Campo obrigatório: ${fd.n}`)
      continue
    }
    const v = coerce(fd, body[fd.n])
    if (v === null && fd.req) throw bad('missing_field', `Campo obrigatório: ${fd.n}`)
    if (v !== null && fd.ref && !(await refExists(c, fd.ref, String(v)))) throw bad('invalid_reference', `Referência inválida em ${fd.n}`)
    data[fd.n] = v
  }
  return data
}

function listWhere(c: AppCtx, res: Res) {
  const a = c.get('auth')
  const where = ['org_id = ?']
  const params: unknown[] = [a.orgId]
  if (res.unit) {
    const scope = unitScope(a, res.read)
    if (scope !== null) {
      if (scope.length === 0) throw forbidden()
      const marks = scope.map(() => '?').join(',')
      where.push(res.unit === 'strict' ? `unit_id IN (${marks})` : `(unit_id IN (${marks}) OR unit_id IS NULL)`)
      params.push(...scope)
    }
  }
  const q = new URL(c.req.url).searchParams
  for (const name of res.filters ?? []) {
    const v = q.get(name)
    if (v !== null && v !== '') {
      const fd = res.fields.find((x) => x.n === name)
      where.push(`${name} = ?`)
      params.push(fd?.t === 'b' ? (v === 'true' || v === '1' ? 1 : 0) : fd?.t === 'i' || fd?.t === 'r' ? Number(v) : v)
    }
  }
  const unitFilter = q.get('unit_id')
  if (res.unit && unitFilter) {
    where.push('unit_id = ?')
    params.push(unitFilter)
  }
  const term = q.get('q')
  if (term && res.search?.length) {
    where.push('(' + res.search.map((s) => `${s} LIKE ?`).join(' OR ') + ')')
    for (let i = 0; i < res.search.length; i++) params.push(`%${term.replace(/[%_]/g, '')}%`)
  }
  const dfrom = q.get('from'), dto = q.get('to')
  const dateCol = res.fields.find((x) => ['date', 'starts_at', 'recorded_at'].includes(x.n))?.n
  if (dateCol && dfrom) { where.push(`${dateCol} >= ?`); params.push(dfrom) }
  if (dateCol && dto) { where.push(`${dateCol} <= ?`); params.push(dto) }
  return { where: where.join(' AND '), params }
}

export function mountCrud(app: Hono<AppEnv>, res: Res) {
  const base = `/${res.path}`

  app.get(base, need(res.read), async (c) => {
    const { where, params } = listWhere(c, res)
    const sp = new URL(c.req.url).searchParams
    const limit = Math.min(Math.max(Number(sp.get('limit') ?? 100) || 100, 1), 500)
    const offset = Math.max(Number(sp.get('offset') ?? 0) || 0, 0)
    const order = res.order ?? 'created_at DESC'
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<any>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${res.table} WHERE ${where}`).bind(...params).first<any>()
    ])
    let items = await Promise.all(rows.results.map((r) => serializeRow(c.env, res, r)))
    if (res.hooks?.view) items = await Promise.all(items.map((i) => res.hooks!.view!(c, i)))
    if (res.auditRead) await audit(c, 'list', res.table, undefined, { count: items.length })
    return c.json({ items, total: total?.n ?? 0, limit, offset })
  })

  app.get(`${base}/:id`, need(res.read), async (c) => {
    const row = await loadRow(c, res, c.req.param('id'))
    if (res.auditRead) await audit(c, 'read', res.table, row.id)
    let out = await serializeRow(c.env, res, row)
    if (res.hooks?.view) out = await res.hooks.view(c, out)
    return c.json(out)
  })

  app.post(base, need(res.write), async (c) => {
    const a = c.get('auth')
    const data = await validate(c, res, await readBody(c), false)
    const id = uid()
    if (res.unit) {
      if (data.unit_id) assertCan(a, res.write, data.unit_id)
      else if (res.unit === 'strict' && !hasOrgWide(a, res.write)) throw forbidden('Informe a unidade')
    }
    await res.hooks?.beforeWrite?.(c, data, null, id)
    const cols = ['id', 'org_id', ...Object.keys(data), 'created_at', 'updated_at']
    const vals: unknown[] = [id, a.orgId]
    for (const k of Object.keys(data)) {
      const fd = res.fields.find((x) => x.n === k)
      vals.push(fd ? await toDb(c.env, res, id, fd, data[k]) : data[k])
    }
    const ts = nowIso()
    vals.push(ts, ts)
    await c.env.DB.prepare(`INSERT INTO ${res.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...vals).run()
    await audit(c, 'create', res.table, id, { fields: Object.keys(data) })
    const row = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=?`).bind(id).first<any>()
    await res.hooks?.afterWrite?.(c, row, null)
    let out = await serializeRow(c.env, res, row)
    if (res.hooks?.view) out = await res.hooks.view(c, out)
    return c.json(out, 201)
  })

  app.put(`${base}/:id`, need(res.write), async (c) => {
    const a = c.get('auth')
    const existing = await loadRow(c, res, c.req.param('id'), res.write)
    const data = await validate(c, res, await readBody(c), true)
    if (res.unit && data.unit_id && data.unit_id !== existing.unit_id) assertCan(a, res.write, data.unit_id)
    await res.hooks?.beforeWrite?.(c, data, existing, existing.id)
    const keys = Object.keys(data)
    if (keys.length) {
      const vals: unknown[] = []
      for (const k of keys) {
        const fd = res.fields.find((x) => x.n === k)
        vals.push(fd ? await toDb(c.env, res, existing.id, fd, data[k]) : data[k])
      }
      await c.env.DB.prepare(`UPDATE ${res.table} SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=? AND org_id=?`)
        .bind(...vals, nowIso(), existing.id, a.orgId).run()
    }
    await audit(c, 'update', res.table, existing.id, { fields: keys })
    const row = await c.env.DB.prepare(`SELECT * FROM ${res.table} WHERE id=?`).bind(existing.id).first<any>()
    await res.hooks?.afterWrite?.(c, row, existing)
    let out = await serializeRow(c.env, res, row)
    if (res.hooks?.view) out = await res.hooks.view(c, out)
    return c.json(out)
  })

  if (res.del !== false) {
    const delPerm = res.del ?? res.write
    app.delete(`${base}/:id`, need(delPerm), async (c) => {
      const row = await loadRow(c, res, c.req.param('id'), delPerm)
      await res.hooks?.beforeDelete?.(c, row)
      await c.env.DB.prepare(`DELETE FROM ${res.table} WHERE id=? AND org_id=?`).bind(row.id, c.get('auth').orgId).run()
      await audit(c, 'delete', res.table, row.id)
      return c.json({ ok: true })
    })
  }
}

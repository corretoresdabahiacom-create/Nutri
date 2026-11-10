import type { Context, MiddlewareHandler } from 'hono'
import { type Env, HttpError, clientIp, forbidden, nowIso, parseJson, uid } from './util'
import { modulesForPerm } from './rbac'
import { randomToken, sha256Hex } from './crypto'

export interface Membership {
  id: string
  roleId: string
  roleKey: string
  unitId: string | null
  /** null = todas as unidades da organização; senão, a unidade e seus descendentes */
  unitIds: Set<string> | null
  perms: Set<string>
}
export interface AuthCtx {
  userId: string
  email: string
  name: string
  orgId: string | null
  isPlatformAdmin: boolean
  mfaEnabled: boolean
  memberships: Membership[]
  modules: Set<string>
  org: { id: string; name: string; aiEnabled: boolean; requireMfa: boolean; limits: Record<string, number>; planKey: string | null } | null
  viaCookie: boolean
}
export type AppEnv = { Bindings: Env; Variables: { auth: AuthCtx } }
export type AppCtx = Context<AppEnv>

export const SESSION_COOKIE = 'nv_session'
export const SESSION_TTL_MS = 12 * 3600 * 1000

export async function createSession(env: Env, userId: string, orgId: string | null, ip: string, ua: string | undefined) {
  const token = randomToken(32)
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,org_id,expires_at,ip,user_agent,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(await sha256Hex(token), userId, orgId, expires, ip, (ua ?? '').slice(0, 200), nowIso())
    .run()
  return { token, expires }
}

export function cookieHeader(token: string, maxAgeSec = SESSION_TTL_MS / 1000) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
}

function readToken(c: Context): { token: string; viaCookie: boolean } | null {
  const h = c.req.header('Authorization')
  if (h?.startsWith('Bearer ')) return { token: h.slice(7).trim(), viaCookie: false }
  const ck = c.req.header('Cookie')
  if (ck) {
    for (const part of ck.split(';')) {
      const [k, ...v] = part.trim().split('=')
      if (k === SESSION_COOKIE) return { token: v.join('='), viaCookie: true }
    }
  }
  return null
}

export async function loadAuth(c: Context<AppEnv>): Promise<AuthCtx | null> {
  const t = readToken(c)
  if (!t || !/^[0-9a-f]{64}$/.test(t.token)) return null
  const env = c.env
  const th = await sha256Hex(t.token)
  const s = await env.DB.prepare('SELECT user_id, org_id, expires_at FROM sessions WHERE token_hash=?').bind(th).first<any>()
  if (!s || s.expires_at <= nowIso()) return null
  const u = await env.DB.prepare('SELECT id,email,name,mfa_enabled,is_platform_admin,active FROM users WHERE id=?').bind(s.user_id).first<any>()
  if (!u || !u.active) return null
  const auth: AuthCtx = {
    userId: u.id, email: u.email, name: u.name, orgId: s.org_id ?? null, isPlatformAdmin: !!u.is_platform_admin,
    mfaEnabled: !!u.mfa_enabled, memberships: [], modules: new Set(), org: null, viaCookie: t.viaCookie
  }
  if (s.org_id) {
    const org = await env.DB.prepare(
      'SELECT o.id,o.name,o.ai_enabled,o.require_mfa,p.key AS plan_key,p.modules,p.limits FROM organizations o LEFT JOIN plans p ON p.id=o.plan_id WHERE o.id=?'
    ).bind(s.org_id).first<any>()
    if (!org) return null
    const mods = parseJson<string[]>(org.modules, [])
    auth.modules = new Set(['core', ...mods])
    auth.org = {
      id: org.id, name: org.name, aiEnabled: !!org.ai_enabled, requireMfa: !!org.require_mfa,
      limits: parseJson(org.limits, {}), planKey: org.plan_key ?? null
    }
    const [ms, units] = await Promise.all([
      env.DB.prepare(
        'SELECT m.id,m.role_id,m.unit_id,r.key AS role_key,r.permissions FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=? AND m.org_id=? AND m.active=1'
      ).bind(u.id, s.org_id).all<any>(),
      env.DB.prepare('SELECT id,parent_unit_id FROM units WHERE org_id=?').bind(s.org_id).all<any>()
    ])
    const children = new Map<string, string[]>()
    for (const un of units.results) if (un.parent_unit_id) children.set(un.parent_unit_id, [...(children.get(un.parent_unit_id) ?? []), un.id])
    const descend = (id: string, acc: Set<string>) => {
      if (acc.has(id)) return
      acc.add(id)
      for (const ch of children.get(id) ?? []) descend(ch, acc)
    }
    for (const m of ms.results) {
      let unitIds: Set<string> | null = null
      if (m.unit_id) {
        unitIds = new Set()
        descend(m.unit_id, unitIds)
      }
      auth.memberships.push({
        id: m.id, roleId: m.role_id, roleKey: m.role_key, unitId: m.unit_id ?? null, unitIds,
        perms: new Set(parseJson<string[]>(m.permissions, []))
      })
    }
    if (auth.memberships.length === 0 && !auth.isPlatformAdmin) return null
  }
  return auth
}

export function can(a: AuthCtx, perm: string, unitId?: string | null): boolean {
  if (!a.orgId) return false
  if (!modulesForPerm(perm).some((m) => a.modules.has(m))) return false
  return a.memberships.some((m) => m.perms.has(perm) && (unitId == null || m.unitIds === null || m.unitIds.has(unitId)))
}

/** null = todas as unidades; array = somente essas; [] = nenhuma. */
export function unitScope(a: AuthCtx, perm: string): string[] | null {
  if (!a.orgId || !modulesForPerm(perm).some((m) => a.modules.has(m))) return []
  const ms = a.memberships.filter((m) => m.perms.has(perm))
  if (ms.some((m) => m.unitIds === null)) return null
  const set = new Set<string>()
  for (const m of ms) for (const id of m.unitIds ?? []) set.add(id)
  return [...set]
}
export const hasOrgWide = (a: AuthCtx, perm: string) => unitScope(a, perm) === null

export function assertCan(a: AuthCtx, perm: string, unitId?: string | null) {
  if (!can(a, perm, unitId)) throw forbidden(`Permissão necessária: ${perm}`)
}

/** Exige sessão válida, aplica CSRF para cookie e MFA obrigatório da organização. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await loadAuth(c)
  if (!auth) throw new HttpError(401, 'unauthenticated', 'Sessão ausente ou expirada')
  if (auth.viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin')
    const host = new URL(c.req.url).host
    const ok = origin ? new URL(origin).host === host : c.req.header('X-Requested-With') === 'nutrivida'
    if (!ok) throw forbidden('Origem da requisição não permitida')
  }
  const path = new URL(c.req.url).pathname
  if (auth.org?.requireMfa && !auth.mfaEnabled && !path.startsWith('/api/auth/')) {
    const privileged = auth.memberships.some((m) => [...m.perms].some((p) => p !== 'portal.self'))
    if (privileged) throw new HttpError(403, 'mfa_required', 'A organização exige MFA: ative a autenticação em dois fatores')
  }
  c.set('auth', auth)
  await next()
}

export const need = (perm: string): MiddlewareHandler<AppEnv> => async (c, next) => {
  assertCan(c.get('auth'), perm)
  await next()
}
export const needAny = (...perms: string[]): MiddlewareHandler<AppEnv> => async (c, next) => {
  const a = c.get('auth')
  if (!perms.some((p) => can(a, p))) throw forbidden(`Permissão necessária: ${perms.join(' ou ')}`)
  await next()
}
export const needPlatformAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('auth').isPlatformAdmin) throw forbidden('Somente administrador da plataforma')
  await next()
}

export async function audit(
  c: AppCtx | { env: Env; auth: AuthCtx | null; ip?: string },
  action: string, entity?: string, entityId?: string, meta: Record<string, unknown> = {}
) {
  const env = 'env' in c && 'auth' in c ? (c as any).env as Env : (c as AppCtx).env
  const auth = 'req' in c ? (c as AppCtx).get('auth') : (c as any).auth as AuthCtx | null
  const ip = 'req' in c ? clientIp(c as AppCtx) : (c as any).ip ?? null
  await env.DB.prepare('INSERT INTO audit_log (id,org_id,user_id,action,entity,entity_id,meta,ip,ts) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(uid(), auth?.orgId ?? null, auth?.userId ?? null, action, entity ?? null, entityId ?? null, JSON.stringify(meta), ip, nowIso())
    .run()
}

/** Janela fixa por chave. Retorna false quando o limite foi excedido. */
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const start = now - (now % windowSec)
  const row = await env.DB.prepare('SELECT window_start,count FROM rate_limits WHERE key=?').bind(key).first<any>()
  if (!row || row.window_start !== start) {
    await env.DB.prepare('INSERT INTO rate_limits (key,window_start,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1')
      .bind(key, start).run()
    return true
  }
  if (row.count >= limit) return false
  await env.DB.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').bind(key).run()
  return true
}

import { Hono } from 'hono'
import {
  type AppEnv, SESSION_TTL_MS, audit, cookieHeader, createSession, rateLimit, SESSION_COOKIE
} from '../lib/auth'
import {
  PBKDF2_ITERATIONS, decryptValue, encryptValue, hashPassword, newTotpSecret, sha256Hex, timingSafeEqual, verifyTotp
} from '../lib/crypto'
import { HttpError, bad, clientIp, conflict, forbidden, nowIso, readBody, uid } from '../lib/util'
import { ALL_PERMS, ROLE_TEMPLATES } from '../lib/rbac'

const lim = (env: any, k: string, d: number) => Number(env[k] ?? d) || d
export const authPublic = new Hono<AppEnv>()
export const authPrivate = new Hono<AppEnv>()

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw))
    throw bad('weak_password', 'A senha deve ter ao menos 10 caracteres, com letras e números')
  return pw
}
const emailOk = (e: unknown): string => {
  if (typeof e !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw bad('invalid_email', 'E-mail inválido')
  return e.toLowerCase().trim()
}

/** Cria papéis-modelo, perfis de orçamento e (se aplicável) categorias de dieta editáveis para uma organização. */
export async function bootstrapOrg(db: D1Database, orgId: string, modules: string[]): Promise<Record<string, string>> {
  const ts = nowIso()
  const roleIds: Record<string, string> = {}
  const stmts: D1PreparedStatement[] = []
  for (const r of ROLE_TEMPLATES) {
    const id = uid()
    roleIds[r.key] = id
    const perms = r.permissions.filter((p) => (ALL_PERMS as readonly string[]).includes(p))
    stmts.push(db.prepare('INSERT INTO roles (id,org_id,key,name,permissions,is_system,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)')
      .bind(id, orgId, r.key, r.name, JSON.stringify(perms), ts, ts))
  }
  const profiles = [
    ['economico', 'Econômico', 'Alimentos acessíveis, sazonais, redução de desperdício e alternativas regionais.'],
    ['intermediario', 'Intermediário', 'Equilíbrio entre variedade, qualidade e custo.'],
    ['premium', 'Premium', 'Ingredientes diferenciados, maior variedade, conveniência e produtos especiais.']
  ]
  for (const [key, name, desc] of profiles)
    stmts.push(db.prepare('INSERT INTO budget_profiles (id,org_id,key,name,description,rules,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(uid(), orgId, key, name, desc, '{}', ts, ts))
  if (modules.includes('clinical')) {
    // Categorias iniciais SEM regras clínicas: a instituição define o que cada denominação significa.
    for (const [key, name] of [['geral', 'Geral'], ['branda', 'Branda'], ['pastosa', 'Pastosa'], ['liquida', 'Líquida'], ['liquida_restrita', 'Líquida restrita'],
      ['hipossodica', 'Hipossódica'], ['hipoglicidica', 'Hipoglicídica'], ['hiperproteica', 'Hiperproteica'], ['hipoproteica', 'Hipoproteica']])
      stmts.push(db.prepare('INSERT INTO diet_types (id,org_id,key,name,description,rules,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(uid(), orgId, key, name, 'Defina as regras desta categoria conforme o protocolo da instituição.', '{}', ts, ts))
  }
  await db.batch(stmts)
  return roleIds
}

authPublic.get('/health', (c) => c.json({ ok: true, service: 'nutrivida-pro', time: nowIso() }))

authPublic.get('/plans', async (c) => {
  const r = await c.env.DB.prepare('SELECT key,name,modules,limits FROM plans WHERE active=1 ORDER BY name').all<any>()
  return c.json({
    items: r.results.map((p) => ({ key: p.key, name: p.name, modules: JSON.parse(p.modules), limits: JSON.parse(p.limits) }))
  })
})

authPublic.post('/auth/register', async (c) => {
  const ip = clientIp(c)
  if (!(await rateLimit(c.env, `register:${ip}`, lim(c.env, 'RL_REGISTER', 10), 3600))) throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde.')
  const b = await readBody(c)
  const email = emailOk(b.email)
  const password = validatePassword(b.password)
  const name = String(b.name ?? '').trim()
  const orgName = String(b.organization_name ?? '').trim()
  if (!name || !orgName) throw bad('missing_field', 'Informe name e organization_name')
  const plan = await c.env.DB.prepare('SELECT id,modules,key FROM plans WHERE key=? AND active=1').bind(String(b.plan_key ?? 'individual')).first<any>()
  if (!plan) throw bad('invalid_plan', 'Plano inexistente')
  if (await c.env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(email).first()) throw conflict('email_in_use', 'E-mail já cadastrado')
  const ts = nowIso()
  const orgId = uid(), userId = uid()
  const pw = await hashPassword(password)
  const isAdmin = !!c.env.PLATFORM_ADMIN_EMAIL && c.env.PLATFORM_ADMIN_EMAIL.toLowerCase() === email
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO organizations (id,name,kind,plan_id,ai_enabled,require_mfa,settings,created_at,updated_at) VALUES (?,?,?,?,0,0,?,?,?)')
      .bind(orgId, orgName, String(b.kind ?? 'generic').slice(0, 40), plan.id, '{}', ts, ts),
    c.env.DB.prepare('INSERT INTO users (id,email,name,password_hash,salt,iterations,is_platform_admin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(userId, email, name.slice(0, 120), pw.hash, pw.salt, pw.iterations, isAdmin ? 1 : 0, ts, ts)
  ])
  const roles = await bootstrapOrg(c.env.DB, orgId, JSON.parse(plan.modules))
  await c.env.DB.prepare('INSERT INTO memberships (id,org_id,user_id,role_id,unit_id,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?)')
    .bind(uid(), orgId, userId, roles.administrador, ts, ts).run()
  const s = await createSession(c.env, userId, orgId, ip, c.req.header('User-Agent'))
  await audit({ env: c.env, auth: { orgId, userId } as any, ip }, 'register_organization', 'organizations', orgId, { plan: plan.key })
  c.header('Set-Cookie', cookieHeader(s.token))
  return c.json({ token: s.token, expires: s.expires, organization_id: orgId, user_id: userId }, 201)
})

const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA=='

authPublic.post('/auth/login', async (c) => {
  const ip = clientIp(c)
  const b = await readBody(c)
  const email = emailOk(b.email)
  if (!(await rateLimit(c.env, `login-ip:${ip}`, lim(c.env, 'RL_LOGIN_IP', 30), 600)) || !(await rateLimit(c.env, `login-email:${email}`, 10, 900)))
    throw new HttpError(429, 'rate_limited', 'Muitas tentativas. Aguarde alguns minutos.')
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first<any>()
  if (!u || !u.active) {
    await hashPassword(String(b.password ?? ''), DUMMY_SALT) // iguala o tempo de resposta
    throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha inválidos')
  }
  if (u.locked_until && u.locked_until > nowIso()) throw new HttpError(423, 'account_locked', 'Conta temporariamente bloqueada por tentativas falhas')
  const h = await hashPassword(String(b.password ?? ''), u.salt, u.iterations)
  if (!timingSafeEqual(h.hash, u.password_hash)) {
    const fails = u.failed_logins + 1
    const lock = fails >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null
    await c.env.DB.prepare('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?').bind(lock ? 0 : fails, lock, u.id).run()
    await audit({ env: c.env, auth: { userId: u.id, orgId: null } as any, ip }, 'login_failed', 'users', u.id)
    throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha inválidos')
  }
  if (u.mfa_enabled) {
    const secret = await decryptValue<string>(c.env, u.mfa_secret, `users.mfa_secret.${u.id}`)
    if (!b.totp) throw new HttpError(401, 'mfa_required', 'Informe o código de autenticação em dois fatores')
    if (!secret || !(await verifyTotp(secret, String(b.totp)))) {
      await audit({ env: c.env, auth: { userId: u.id, orgId: null } as any, ip }, 'mfa_failed', 'users', u.id)
      throw new HttpError(401, 'invalid_mfa', 'Código de autenticação inválido')
    }
  }
  await c.env.DB.prepare('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?').bind(u.id).run()
  const orgs = (await c.env.DB.prepare(
    'SELECT DISTINCT o.id,o.name FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? AND m.active=1'
  ).bind(u.id).all<any>()).results
  let orgId: string | null = null
  if (b.org_id) {
    if (!orgs.some((o) => o.id === b.org_id)) throw forbidden('Você não pertence a esta organização')
    orgId = b.org_id
  } else if (orgs.length === 1) orgId = orgs[0].id
  const s = await createSession(c.env, u.id, orgId, ip, c.req.header('User-Agent'))
  await audit({ env: c.env, auth: { userId: u.id, orgId } as any, ip }, 'login', 'users', u.id)
  c.header('Set-Cookie', cookieHeader(s.token))
  return c.json({ token: s.token, expires: s.expires, organization_id: orgId, organizations: orgs, needs_org: orgId === null && orgs.length > 1 })
})

authPublic.post('/auth/accept-invitation', async (c) => {
  const b = await readBody(c)
  const ip = clientIp(c)
  if (!(await rateLimit(c.env, `invite:${ip}`, 20, 3600))) throw new HttpError(429, 'rate_limited', 'Muitas tentativas')
  const inv = await c.env.DB.prepare('SELECT * FROM invitations WHERE token_hash=?').bind(await sha256Hex(String(b.token ?? ''))).first<any>()
  if (!inv || inv.accepted_at || inv.expires_at < nowIso()) throw bad('invalid_invitation', 'Convite inválido ou expirado')
  if (await c.env.DB.prepare('SELECT 1 FROM users WHERE email=?').bind(inv.email).first())
    throw conflict('email_in_use', 'Este e-mail já possui conta. Entre e aceite o convite autenticado.')
  const password = validatePassword(b.password)
  const name = String(b.name ?? '').trim()
  if (!name) throw bad('missing_field', 'Informe o nome')
  const ts = nowIso(), userId = uid(), pw = await hashPassword(password)
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id,email,name,password_hash,salt,iterations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(userId, inv.email, name.slice(0, 120), pw.hash, pw.salt, pw.iterations, ts, ts),
    c.env.DB.prepare('INSERT INTO memberships (id,org_id,user_id,role_id,unit_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), inv.org_id, userId, inv.role_id, inv.unit_id, ts, ts),
    c.env.DB.prepare('UPDATE invitations SET accepted_at=? WHERE id=?').bind(ts, inv.id)
  ])
  await audit({ env: c.env, auth: { userId, orgId: inv.org_id } as any, ip }, 'accept_invitation', 'invitations', inv.id)
  return c.json({ ok: true, user_id: userId }, 201)
})

// ---------- autenticadas ----------

authPrivate.get('/auth/me', async (c) => {
  const a = c.get('auth')
  const perms = new Set<string>()
  for (const m of a.memberships) for (const p of m.perms) perms.add(p)
  const orgs = (await c.env.DB.prepare(
    'SELECT DISTINCT o.id,o.name FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? AND m.active=1'
  ).bind(a.userId).all<any>()).results
  return c.json({
    user: { id: a.userId, email: a.email, name: a.name, mfa_enabled: a.mfaEnabled, is_platform_admin: a.isPlatformAdmin },
    organization: a.org && { id: a.org.id, name: a.org.name, ai_enabled: a.org.aiEnabled, require_mfa: a.org.requireMfa, plan: a.org.planKey, limits: a.org.limits },
    organizations: orgs,
    modules: [...a.modules],
    permissions: [...perms].sort(),
    memberships: a.memberships.map((m) => ({ id: m.id, role: m.roleKey, unit_id: m.unitId }))
  })
})

authPrivate.post('/auth/logout', async (c) => {
  const h = c.req.header('Authorization')
  const ck = c.req.header('Cookie') ?? ''
  const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : ck.split(';').map((x) => x.trim()).find((x) => x.startsWith(SESSION_COOKIE + '='))?.split('=')[1]
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256Hex(token)).run()
  c.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`)
  return c.json({ ok: true })
})

authPrivate.post('/auth/switch-org', async (c) => {
  const a = c.get('auth')
  const b = await readBody(c)
  const ok = await c.env.DB.prepare('SELECT 1 FROM memberships WHERE user_id=? AND org_id=? AND active=1').bind(a.userId, String(b.org_id ?? '')).first()
  if (!ok) throw forbidden('Você não pertence a esta organização')
  const s = await createSession(c.env, a.userId, b.org_id, clientIp(c), c.req.header('User-Agent'))
  c.header('Set-Cookie', cookieHeader(s.token))
  return c.json({ token: s.token, expires: s.expires, organization_id: b.org_id })
})

authPrivate.post('/auth/change-password', async (c) => {
  const a = c.get('auth')
  const b = await readBody(c)
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(a.userId).first<any>()
  const h = await hashPassword(String(b.current_password ?? ''), u.salt, u.iterations)
  if (!timingSafeEqual(h.hash, u.password_hash)) throw new HttpError(401, 'invalid_credentials', 'Senha atual incorreta')
  const pw = await hashPassword(validatePassword(b.new_password))
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash=?,salt=?,iterations=?,updated_at=? WHERE id=?').bind(pw.hash, pw.salt, pw.iterations, nowIso(), a.userId),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(a.userId) // encerra todas as sessões
  ])
  await audit(c, 'change_password', 'users', a.userId)
  return c.json({ ok: true })
})

authPrivate.post('/auth/mfa/setup', async (c) => {
  const a = c.get('auth')
  if (a.mfaEnabled) throw conflict('mfa_already_enabled', 'MFA já está ativo')
  const secret = newTotpSecret()
  await c.env.DB.prepare('UPDATE users SET mfa_secret=? WHERE id=?').bind(await encryptValue(c.env, secret, `users.mfa_secret.${a.userId}`), a.userId).run()
  return c.json({ secret, otpauth_url: `otpauth://totp/NutriVidaPro:${encodeURIComponent(a.email)}?secret=${secret}&issuer=NutriVidaPro&digits=6&period=30` })
})
authPrivate.post('/auth/mfa/enable', async (c) => {
  const a = c.get('auth')
  const b = await readBody(c)
  const u = await c.env.DB.prepare('SELECT mfa_secret FROM users WHERE id=?').bind(a.userId).first<any>()
  const secret = await decryptValue<string>(c.env, u?.mfa_secret, `users.mfa_secret.${a.userId}`)
  if (!secret) throw bad('mfa_not_setup', 'Execute /auth/mfa/setup primeiro')
  if (!(await verifyTotp(secret, String(b.code ?? '')))) throw bad('invalid_mfa', 'Código inválido')
  await c.env.DB.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').bind(a.userId).run()
  await audit(c, 'mfa_enabled', 'users', a.userId)
  return c.json({ ok: true })
})
authPrivate.post('/auth/mfa/disable', async (c) => {
  const a = c.get('auth')
  const b = await readBody(c)
  if (a.org?.requireMfa) throw forbidden('A organização exige MFA')
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(a.userId).first<any>()
  const h = await hashPassword(String(b.password ?? ''), u.salt, u.iterations)
  const secret = await decryptValue<string>(c.env, u.mfa_secret, `users.mfa_secret.${a.userId}`)
  if (!timingSafeEqual(h.hash, u.password_hash) || !secret || !(await verifyTotp(secret, String(b.code ?? ''))))
    throw new HttpError(401, 'invalid_credentials', 'Senha ou código inválido')
  await c.env.DB.prepare('UPDATE users SET mfa_enabled=0, mfa_secret=NULL WHERE id=?').bind(a.userId).run()
  await audit(c, 'mfa_disabled', 'users', a.userId)
  return c.json({ ok: true })
})
export { SESSION_TTL_MS, PBKDF2_ITERATIONS }

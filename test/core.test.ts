import { describe, expect, it } from 'vitest'
import { PW, call, del, get, newOrg, post, put, roleId, unit, userWithRole } from './helpers'

describe('núcleo: organização, usuários e isolamento', () => {
  it('registra organização, faz login e lê /auth/me', async () => {
    const o = await newOrg()
    const me = await get('/api/auth/me', o.token)
    expect(me.status).toBe(200)
    expect(me.data.organization.id).toBe(o.orgId)
    expect(me.data.permissions).toContain('users.manage')
    expect(me.data.modules).toContain('clinical')
  })
  it('rejeita senha fraca e e-mail duplicado', async () => {
    const weak = await post('/api/auth/register', undefined, { email: 'a@b.co', password: '123', name: 'x', organization_name: 'y' })
    expect(weak.status).toBe(400)
    const o = await newOrg()
    const dup = await post('/api/auth/register', undefined, { email: o.email, password: PW, name: 'x', organization_name: 'y' })
    expect(dup.status).toBe(409)
  })
  it('exige autenticação', async () => {
    expect((await get('/api/units')).status).toBe(401)
    expect((await get('/api/units', '0'.repeat(64))).status).toBe(401)
  })
  it('cria unidades e hierarquia sem ciclos', async () => {
    const o = await newOrg()
    const a = await unit(o.token, 'Resort', 'resort')
    const b = await unit(o.token, 'Restaurante A', 'restaurant', a)
    const cyc = await put(`/api/units/${a}`, o.token, { parent_unit_id: b })
    expect(cyc.status).toBe(400)
    expect((await get('/api/units', o.token)).data.total).toBe(2)
  })
  it('ISOLAMENTO: organização B não vê nem altera dados da A', async () => {
    const a = await newOrg(), b = await newOrg()
    const ua = await unit(a.token, 'Unidade A')
    expect((await get('/api/units', b.token)).data.items.some((u: any) => u.id === ua)).toBe(false)
    expect((await get(`/api/units/${ua}`, b.token)).status).toBe(404)
    expect((await put(`/api/units/${ua}`, b.token, { name: 'hack' })).status).toBe(404)
    expect((await del(`/api/units/${ua}`, b.token)).status).toBe(404)
    // referência cruzada: B não pode criar departamento apontando para unidade da A
    const r = await post('/api/departments', b.token, { name: 'X', unit_id: ua })
    expect(r.status).toBe(400)
  })
  it('papéis: usuário com papel restrito não acessa o que não deve (backend)', async () => {
    const o = await newOrg()
    const chef = await userWithRole(o.token, 'cozinheiro')
    expect((await get('/api/users', chef.token)).status).toBe(403)
    expect((await post('/api/units', chef.token, { name: 'x' })).status).toBe(403)
    const aud = await userWithRole(o.token, 'auditor')
    expect((await get('/api/audit', aud.token)).status).toBe(200)
  })
  it('impede escalonamento de privilégio ao criar papel/atribuir papel', async () => {
    const o = await newOrg()
    const gestor = await userWithRole(o.token, 'gestor')
    const rid = await roleId(o.token, 'administrador')
    expect((await post('/api/users', gestor.token, { email: 'x@y.co', name: 'x', password: PW, role_id: rid })).status).toBe(403)
  })
  it('um usuário pode ter mais de um papel; escopo por unidade é respeitado', async () => {
    const o = await newOrg()
    const u1 = await unit(o.token, 'U1'), u2 = await unit(o.token, 'U2')
    const u = await userWithRole(o.token, 'nutricionista_uan', u1)
    const prod = await roleId(o.token, 'somente_leitura')
    const add = await post('/api/users', o.token, { email: (await get('/api/users', o.token)).data.items.find((x: any) => x.id === u.userId).email, role_id: prod, unit_id: u2 })
    expect(add.status).toBe(201)
    const users = (await get('/api/users', o.token)).data.items.find((x: any) => x.id === u.userId)
    expect(users.memberships.length).toBe(2)
  })
  it('não remove o último administrador', async () => {
    const o = await newOrg()
    const me = await get('/api/users', o.token)
    const m = me.data.items[0].memberships[0].id
    expect((await del(`/api/memberships/${m}`, o.token)).status).toBe(409)
  })
  it('auditoria registra ações e é isolada por organização', async () => {
    const a = await newOrg(), b = await newOrg()
    await unit(a.token, 'U')
    const la = await get('/api/audit?entity=units', a.token)
    expect(la.data.items.length).toBeGreaterThan(0)
    const lb = await get('/api/audit?entity=units', b.token)
    expect(lb.data.items.length).toBe(0)
  })
  it('limite do plano é aplicado', async () => {
    const o = await newOrg('individual')
    await unit(o.token, 'U1')
    expect((await post('/api/units', o.token, { name: 'U2' })).status).toBe(402)
  })
  it('módulos do plano: individual não acessa módulo hospitalar', async () => {
    const o = await newOrg('individual')
    expect((await get('/api/patients', o.token)).status).toBeGreaterThanOrEqual(403)
  })
})

describe('segurança de sessão', () => {
  it('bloqueia conta após tentativas falhas e aplica logout', async () => {
    const o = await newOrg()
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/login', undefined, { email: o.email, password: 'errada-12345' })).status).toBe(401)
    expect((await post('/api/auth/login', undefined, { email: o.email, password: PW })).status).toBe(423)
  })
  it('logout invalida o token', async () => {
    const o = await newOrg()
    expect((await post('/api/auth/logout', o.token)).status).toBe(200)
    expect((await get('/api/auth/me', o.token)).status).toBe(401)
  })
  it('MFA TOTP: setup, enable e exigência no login', async () => {
    const { totpCode } = await import('../src/worker/lib/crypto')
    const o = await newOrg()
    const s = await post('/api/auth/mfa/setup', o.token)
    const code = await totpCode(s.data.secret, Math.floor(Date.now() / 30000))
    expect((await post('/api/auth/mfa/enable', o.token, { code })).status).toBe(200)
    const l1 = await post('/api/auth/login', undefined, { email: o.email, password: PW })
    expect(l1.status).toBe(401)
    expect(l1.data.error.code).toBe('mfa_required')
    const l2 = await post('/api/auth/login', undefined, { email: o.email, password: PW, totp: await totpCode(s.data.secret, Math.floor(Date.now() / 30000)) })
    expect(l2.status).toBe(200)
  })
  it('organização com MFA obrigatório bloqueia perfis sem MFA', async () => {
    const o = await newOrg()
    expect((await put('/api/org', o.token, { require_mfa: true })).status).toBe(200)
    const r = await get('/api/units', o.token)
    expect(r.status).toBe(403)
    expect(r.data.error.code).toBe('mfa_required')
  })
  it('CSRF: cookie com origem diferente é recusado', async () => {
    const o = await newOrg()
    const res = await (await import('cloudflare:test')).SELF.fetch('http://localhost/api/units', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `nv_session=${o.token}`, Origin: 'http://evil.example' }, body: JSON.stringify({ name: 'x' })
    })
    expect(res.status).toBe(403)
  })
  it('dados sensíveis cifrados em repouso (segredo MFA não fica em texto claro)', async () => {
    const { env } = await import('cloudflare:test')
    const o = await newOrg()
    const s = await post('/api/auth/mfa/setup', o.token)
    const row: any = await (env as any).DB.prepare('SELECT mfa_secret FROM users WHERE id=?').bind(o.userId).first()
    expect(row.mfa_secret.startsWith('v1.')).toBe(true)
    expect(row.mfa_secret.includes(s.data.secret)).toBe(false)
  })
})

describe('rate limiting', () => {
  it('bloqueia após exceder o limite da janela', async () => {
    const { env } = await import('cloudflare:test')
    const { rateLimit } = await import('../src/worker/lib/auth')
    const key = 'teste:' + crypto.randomUUID()
    const r = []
    for (let i = 0; i < 5; i++) r.push(await rateLimit(env as any, key, 3, 60))
    expect(r).toEqual([true, true, true, false, false])
  })
})

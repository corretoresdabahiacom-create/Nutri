import { describe, expect, it } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { call, get, newOrg, post, unit, userWithRole } from './helpers'
import { purgeExpired } from '../src/worker/lib/jobs'

const raw = (p: string, t: string) => SELF.fetch('http://localhost' + p, { headers: { Authorization: 'Bearer ' + t } })
describe('LGPD', () => {
  it('exporta dados decifrados do titular e registra a solicitação', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'Hosp', 'hospital')
    const p = (await post('/api/patients', o.token, { unit_id: u, internal_code: 'P1', name: 'Maria Teste', allergies: ['Amendoim'], diagnoses: 'Diabetes' })).data.id
    const r = await raw(`/api/lgpd/subjects/patient/${p}/export`, o.token); expect(r.status).toBe(200)
    const b = await r.json() as any; expect(b.subject.name).toBe('Maria Teste'); expect(b.subject.allergies).toEqual(['Amendoim']); expect(b.subject.diagnoses).toBe('Diabetes')
    expect((await get('/api/lgpd/requests', o.token)).data.items[0].kind).toBe('export')
  })
  it('anonimiza: exige confirmação e motivo, bloqueia internado, remove identificadores e documentos', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'Hosp', 'hospital')
    const p = (await post('/api/patients', o.token, { unit_id: u, internal_code: 'P2', name: 'João Teste', allergies: ['Leite'] })).data.id
    const url = `/api/lgpd/subjects/patient/${p}/anonymize`
    expect((await post(url, o.token, { reason: 'pedido do titular' })).status).toBe(400)
    expect((await post(url, o.token, { confirm: true, reason: 'pedido do titular' })).data.error.code).toBe('patient_admitted')
    expect((await (await import('./helpers')).put(`/api/patients/${p}`, o.token, { status: 'discharged' })).status).toBe(200)
    const d = await post('/api/documents', o.token, { title: 'x.txt', mime: 'text/plain', content_b64: btoa('oi'), related_type: 'patients', related_id: p })
    expect(d.status).toBe(201)
    expect((await post(url, o.token, { confirm: true, reason: 'pedido do titular' })).status).toBe(200)
    const row = await env.DB.prepare('SELECT name, allergies, internal_code, anonymized_at FROM patients WHERE id=?').bind(p).first<any>()
    expect(row!.name).toBe('Paciente anonimizado'); expect(row!.allergies).toBeNull(); expect(row!.internal_code).toMatch(/^ANON-/); expect(row!.anonymized_at).toBeTruthy()
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM documents WHERE related_id=?').bind(p).first<any>())!.n).toBe(0)
    expect((await post(url, o.token, { confirm: true, reason: 'pedido do titular' })).data.error.code).toBe('already_anonymized')
  })
  it('isolamento e permissão: outra organização e perfil sem lgpd.manage recebem 404/403', async () => {
    const a = await newOrg(), b = await newOrg(); const u = await unit(a.token, 'Hosp', 'hospital')
    const p = (await post('/api/patients', a.token, { unit_id: u, internal_code: 'P3', name: 'X' })).data.id
    expect((await raw(`/api/lgpd/subjects/patient/${p}/export`, b.token)).status).toBe(404)
    const cook = await userWithRole(a.token, 'cozinheiro', u)
    expect((await raw(`/api/lgpd/subjects/patient/${p}/export`, cook.token)).status).toBe(403)
  })
  it('apaga restrições de hóspede e a retenção remove só dados operacionais vencidos', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'Hotel', 'hotel'); const ts = new Date().toISOString()
    await env.DB.prepare("INSERT INTO guest_restrictions (id,org_id,unit_id,guest_ref,consent_given,created_at,updated_at) VALUES ('g1',?,?,'apto 1',1,?,?)").bind(o.orgId, u, ts, ts).run()
    expect((await call('DELETE', '/api/lgpd/guests/g1', o.token)).status).toBe(200)
    expect(await env.DB.prepare("SELECT id FROM guest_restrictions WHERE id='g1'").first()).toBeNull()
    await env.DB.prepare("INSERT INTO sessions (token_hash,user_id,org_id,expires_at,created_at) VALUES ('old','u',?, '2000-01-01T00:00:00Z', ?)").bind(o.orgId, ts).run()
    const r = await purgeExpired(env as any); expect(r.sessions).toBeGreaterThanOrEqual(1)
    expect((await get('/api/auth/me', o.token)).status).toBe(200) // sessão válida preservada
  })
})

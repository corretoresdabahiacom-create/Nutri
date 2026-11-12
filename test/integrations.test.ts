import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { call, get, newOrg, post, put, unit } from './helpers'
import { hmacHex } from '../src/worker/lib/outbound'
import { runDueJobs } from '../src/worker/lib/jobs'

const b64 = (s: string | Uint8Array) => { const u = typeof s === 'string' ? new TextEncoder().encode(s) : s; let o = ''; for (let i = 0; i < u.length; i += 8192) o += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(o) }
async function doc(t: string, extra: Record<string, unknown> = {}, content: string | Uint8Array = 'conteudo fictício') {
  const r = await post('/api/documents', t, { title: 'laudo.txt', mime: 'text/plain', content_b64: b64(content), ...extra }); expect(r.status).toBe(201); return r.data.id as string
}
const mockFetch = (status = 200, body: unknown = { id: 'msg_1' }) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
afterEach(() => vi.restoreAllMocks())

describe('integrações de saída', () => {
  it('lista o que é implementado de verdade e o que não é', async () => {
    const o = await newOrg(); const r = await get('/api/integrations', o.token)
    const by = Object.fromEntries(r.data.items.map((i: any) => [i.kind, i]))
    expect(by.email.implemented).toBe(true); expect(by.erp_webhook.implemented).toBe(true); expect(by.scale.implemented).toBe(true)
    expect(by.billing.implemented).toBe(false); expect(by.google_calendar.implemented).toBe(false)
  })
  it('sem configuração: recusa o envio e não marca nada como enviado', async () => {
    const o = await newOrg(); const id = await doc(o.token); const f = mockFetch()
    const r = await post(`/api/documents/${id}/send-email`, o.token, { confirm: true, to: 'a@b.com' })
    expect(r.status).toBe(424); expect(f).not.toHaveBeenCalled()
    const ob = await get('/api/outbox', o.token); expect(ob.data.items[0].status).toBe('not_configured')
  })
  it('envia só com confirmação, config e 2xx; falha do provedor fica na fila com tentativa', async () => {
    const o = await newOrg(); const id = await doc(o.token)
    expect((await post(`/api/documents/${id}/send-email`, o.token, { to: 'a@b.com' })).status).toBe(400)
    expect((await put('/api/integrations/email', o.token, { config: { api_key: 're_x', from: 'Nutri <no-reply@exemplo.com>' } })).status).toBe(200)
    let f = mockFetch(200, { id: 'abc' })
    const ok = await post(`/api/documents/${id}/send-email`, o.token, { confirm: true, to: 'a@b.com' })
    expect(ok.status).toBe(200); expect(ok.data.status).toBe('sent')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails'); expect((init.headers as any).Authorization).toBe('Bearer re_x')
    f.mockRestore(); f = mockFetch(500, { message: 'boom' })
    const bad = await post(`/api/documents/${id}/send-email`, o.token, { confirm: true, to: 'a@b.com' })
    expect(bad.status).toBe(502)
    const ob = await get('/api/outbox', o.token)
    expect(ob.data.items.some((m: any) => m.status === 'queued' && m.attempts === 1)).toBe(true)
    expect(JSON.stringify(ob.data)).not.toContain('re_x')
    const cfg = await get('/api/integrations', o.token); expect(JSON.stringify(cfg.data)).not.toContain('re_x')
  })
  it('documento clínico exige base legal para compartilhar', async () => {
    const o = await newOrg(); const id = await doc(o.token, { related_type: 'patients', related_id: 'x' })
    await put('/api/integrations/email', o.token, { config: { api_key: 'k', from: 'n@exemplo.com' } })
    const f = mockFetch()
    expect((await post(`/api/documents/${id}/send-email`, o.token, { confirm: true, to: 'a@b.com' })).data.error.code).toBe('legal_basis_required')
    expect(f).not.toHaveBeenCalled()
    expect((await post(`/api/documents/${id}/send-email`, o.token, { confirm: true, to: 'a@b.com', legal_basis: 'Tutela da saúde (LGPD art. 7º, VIII)' })).status).toBe(200)
  })
  it('WhatsApp usa a API oficial e o cron reenvia mensagens pendentes', async () => {
    const o = await newOrg()
    await put('/api/integrations/whatsapp_business', o.token, { config: { token: 'tk', phone_id: '123' } })
    const f = mockFetch(200, { messages: [{ id: 'wamid.1' }] })
    const t = await post('/api/integrations/whatsapp_business/test', o.token, { to: '+55 71 99999-0000' })
    expect(t.status).toBe(200)
    expect(String(f.mock.calls[0][0])).toContain('graph.facebook.com'); expect(JSON.parse((f.mock.calls[0][1] as any).body).to).toBe('5571999990000')
    f.mockRestore(); mockFetch(503)
    expect((await post('/api/integrations/whatsapp_business/test', o.token, { to: '5571999990000' })).status).toBe(502)
    const ts = new Date().toISOString()
    await env.DB.prepare("INSERT INTO outbound_messages (id,org_id,channel,to_addr,body,status,attempts,next_attempt_at,created_at,updated_at) VALUES ('m1',?,'whatsapp','5571999990000','oi','queued',1,?,?,?)").bind(o.orgId, ts, ts, ts).run()
    vi.restoreAllMocks(); mockFetch(200, { messages: [{ id: 'w2' }] })
    expect((await runDueJobs(env as any)).outbox_retried).toBeGreaterThanOrEqual(1)
    expect((await env.DB.prepare("SELECT status FROM outbound_messages WHERE id='m1'").first<any>())!.status).toBe('sent')
  })
  it('webhook ERP: bloqueia destinos inseguros e assina o corpo com HMAC', async () => {
    const o = await newOrg()
    for (const url of ['http://exemplo.com/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://169.254.169.254/x', 'https://interno/x'])
      expect((await put('/api/integrations/erp_webhook', o.token, { config: { url, secret: 's' } })).status).toBe(400)
    expect((await put('/api/integrations/erp_webhook', o.token, { config: { url: 'https://erp.exemplo.com/hook', secret: 'segredo' } })).status).toBe(200)
    const f = mockFetch(200, {})
    expect((await post('/api/integrations/erp_webhook/test', o.token, {})).status).toBe(200)
    const [, init] = f.mock.calls[0] as [string, RequestInit]
    expect((init.headers as any)['X-NutriVida-Signature']).toBe('sha256=' + (await hmacHex('segredo', init.body as string)))
  })
})

describe('integrações de entrada (token)', () => {
  const tok = async (t: string, kind: string, unit_id?: string) => { const r = await post('/api/integration-tokens', t, { kind, unit_id }); expect(r.status).toBe(201); return r.data.token as string }
  const inb = (path: string, token: string | undefined, body: unknown) => call('POST', '/api/inbound' + path, token, body)

  it('PDV: importa vendas, rejeita token errado/de outro tipo/revogado e isola organizações', async () => {
    const o = await newOrg(), o2 = await newOrg(); const u = await unit(o.token, 'Rest', 'restaurant'), u2 = await unit(o2.token, 'Outra', 'restaurant')
    const fd = (await post('/api/foods', o.token, { name: 'Arroz', source: 'DEMO fictício', energy_kcal: 100, protein_g: 5, carb_g: 20, fat_g: 2, fiber_g: 1, sodium_mg: 100 })).data.id
    const rid = (await post('/api/recipes', o.token, { name: 'Prato', portions: 10, yield_g: 2000, items: [{ food_id: fd, net_g: 1000, gross_g: 1000 }] })).data.id
    expect((await post(`/api/recipes/${rid}/approve`, o.token, { nutrition_reviewed: true, allergens_reviewed: true })).status).toBe(200)
    const t = await tokenFor(o.token, 'pdv')
    const rows = [{ date: '2026-11-01', recipe_name: 'Prato', qty: 3, revenue: 90 }, { date: 'x', recipe_name: 'Prato', qty: 1, revenue: 1 }]
    expect((await inb('/pdv', undefined, { unit_id: u, rows })).status).toBe(401)
    expect((await inb('/pdv', 'nvi_falso', { unit_id: u, rows })).status).toBe(401)
    expect((await inb('/pdv', await tokenFor(o.token, 'scale'), { unit_id: u, rows })).status).toBe(401)
    const r = await inb('/pdv', t, { unit_id: u, rows }); expect(JSON.stringify(r.data)).toContain('"imported":1'); expect(r.status).toBe(201); expect(r.data.imported).toBe(1); expect(r.data.skipped).toBe(1)
    expect((await inb('/pdv', t, { unit_id: u2, rows })).status).toBe(400) // unidade de outra organização
    const sales = await get(`/api/sales?unit_id=${u}`, o.token); expect(sales.data.items[0].source).toBe('pdv')
    const list = await get('/api/integration-tokens', o.token); expect(JSON.stringify(list.data)).not.toContain(t)
    await call('DELETE', `/api/integration-tokens/${list.data.items.find((x: any) => x.kind === 'pdv').id}`, o.token)
    expect((await inb('/pdv', t, { unit_id: u, rows })).status).toBe(401)
    async function tokenFor(a: string, k: string) { return tok(a, k) }
  })
  it('token restrito a uma unidade não opera em outra', async () => {
    const o = await newOrg(); const u1 = await unit(o.token, 'H1', 'hotel'), u2 = await unit(o.token, 'H2', 'hotel')
    const t = await tok(o.token, 'hotel_pms', u1)
    const days = [{ date: '2026-12-01', rooms_occupied: 10, adults: 20, children: 4 }]
    expect((await inb('/pms', t, { unit_id: u2, days })).status).toBe(403)
    const ok = await inb('/pms', t, { days }); expect(ok.status).toBe(201); expect(ok.data.upserted).toBe(1)
    expect((await inb('/pms', t, { days: [{ date: '2026-12-01', adults: 30 }] })).status).toBe(201) // upsert idempotente
    const r = await env.DB.prepare('SELECT COUNT(*) n, MAX(adults) a, MAX(source) s FROM occupancy_forecasts WHERE unit_id=?').bind(u1).first<any>()
    expect([r!.n, r!.a, r!.s]).toEqual([1, 30, 'pms'])
  })
  it('balança: calcula peso líquido, valida tara e gera registro de desperdício', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'UAN', 'uan'); const t = await tok(o.token, 'scale', u)
    const fd = (await post('/api/foods', o.token, { name: 'Feijão', source: 'DEMO fictício' })).data.id
    const r = await inb('/scale', t, { device: 'BAL-01', readings: [{ kind: 'desperdicio', weight_g: 1500, tare_g: 500, food_id: fd }, { kind: 'sobra', weight_g: 100, tare_g: 100 }, { kind: 'xx', weight_g: 5 }] })
    expect(r.status).toBe(201); expect(r.data.accepted[0].net_g).toBe(1000); expect(r.data.rejected).toHaveLength(2)
    const w = await get(`/api/waste?unit_id=${u}`, o.token); expect(w.data.items.some((x: any) => x.qty_g === 1000 && x.kind === 'desperdicio')).toBe(true)
  })
  it('HIS/FHIR: cria paciente, atualiza e adiciona alergia cifrada sem duplicar', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'Hosp', 'hospital'); const t = await tok(o.token, 'hospital_his', u)
    const bundle = { resourceType: 'Bundle', type: 'collection', entry: [
      { resource: { resourceType: 'Patient', id: 'p1', identifier: [{ value: 'PRONT-1' }], name: [{ given: ['Maria'], family: 'Teste' }], gender: 'female', birthDate: '1980-05-02' } },
      { resource: { resourceType: 'AllergyIntolerance', id: 'a1', patient: { reference: 'Patient/p1' }, code: { text: 'Amendoim' } } }] }
    const r1 = await inb('/his/fhir', t, bundle); expect(r1.status).toBe(201); expect([r1.data.created, r1.data.allergies_added]).toEqual([1, 1])
    const r2 = await inb('/his/fhir', t, bundle); expect([r2.data.created, r2.data.updated, r2.data.allergies_added]).toEqual([0, 1, 0])
    const pts = await get(`/api/patients?unit_id=${u}`, o.token); expect(pts.data.items[0].name).toBe('Maria Teste'); expect(pts.data.items[0].allergies).toEqual(['Amendoim'])
    const raw = await env.DB.prepare('SELECT allergies FROM patients').first<any>(); expect(raw!.allergies).not.toContain('Amendoim')
    expect((await inb('/his/fhir', t, { resourceType: 'Patient' })).status).toBe(400)
  })
})

describe('feed ICS e anexos grandes', () => {
  it('feed por usuário é privado, revogável e só expõe eventos do próprio usuário', async () => {
    const o = await newOrg()
    await post('/api/events', o.token, { title: 'Consulta, "A;B"', starts_at: new Date(Date.now() + 86400000).toISOString(), owner_user_id: o.userId })
    const f = await post('/api/calendar-feed', o.token, {}); expect(f.status).toBe(201)
    const ics = await get(f.data.url_path); expect(ics.status).toBe(200); expect(ics.headers.get('content-type')).toContain('text/calendar')
    expect(ics.data).toContain('BEGIN:VEVENT'); expect(JSON.stringify(ics.data)).toContain('SUMMARY:Consulta')
    const f2 = await post('/api/calendar-feed', o.token, {}); expect((await get(f.data.url_path)).status).toBe(404); expect((await get(f2.data.url_path)).status).toBe(200)
    expect((await get('/api/public/calendar/nvc_inexistente.ics')).status).toBe(404)
  })
  it('documento de ~3 MB é gravado em fragmentos e baixado íntegro; acima do limite é recusado', async () => {
    const o = await newOrg(); const bytes = new Uint8Array(3 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251
    const id = await doc(o.token, { title: 'grande.txt' }, bytes)
    const n = await env.DB.prepare('SELECT chunk_count FROM documents WHERE id=?').bind(id).first<any>(); expect(n!.chunk_count).toBeGreaterThan(1)
    const res = await fetch('http://localhost/api/documents/' + id + '/content', { headers: { Authorization: 'Bearer ' + o.token } }).catch(() => null)
    const dl = await (await import('cloudflare:test')).SELF.fetch(`http://localhost/api/documents/${id}/content`, { headers: { Authorization: 'Bearer ' + o.token } })
    const got = new Uint8Array(await dl.arrayBuffer()); expect(got.length).toBe(bytes.length); expect(got.every((v, i) => v === bytes[i])).toBe(true); void res
    await call('DELETE', `/api/documents/${id}`, o.token)
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM document_chunks WHERE doc_id=?').bind(id).first<any>())!.n).toBe(0)
    const big = await post('/api/documents', o.token, { title: 'x', mime: 'text/plain', content_b64: 'A'.repeat(12 * 1024 * 1024) }); expect(big.status).toBe(400)
  })
})

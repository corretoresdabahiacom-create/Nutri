import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { get, newOrg, post, put, unit, userWithRole, roleId, PW } from './helpers'
import { runDueJobs } from '../src/worker/lib/jobs'

async function food(t: string, name: string, extra: Record<string, unknown> = {}) {
  const r = await post('/api/foods', t, { name, source: 'DEMO fictício', category: 'cereais', energy_kcal: 100, protein_g: 5, carb_g: 20, fat_g: 2, fiber_g: 1, sodium_mg: 100, ...extra })
  expect(r.status).toBe(201); return r.data.id as string
}
const setup = async () => { const o = await newOrg('enterprise'); return { o, u: await unit(o.token, 'UAN', 'uan') } }

describe('qualidade', () => {
  it('temperatura fora do limite abre não conformidade automática; encerrar exige ação corretiva concluída', async () => {
    const { o, u } = await setup()
    expect((await post('/api/temperature-logs', o.token, { unit_id: u, equipment: 'Câmara 1', reading_c: 4 })).status).toBe(400) // sem limites
    const ok = await post('/api/temperature-logs', o.token, { unit_id: u, equipment: 'Câmara 1', reading_c: 4, limit_max_c: 5 })
    expect(ok.data.ok).toBe(true); expect(ok.data.nonconformity_id).toBeNull()
    const bad = await post('/api/temperature-logs', o.token, { unit_id: u, equipment: 'Câmara 1', reading_c: 9, limit_max_c: 5 })
    expect(bad.data.ok).toBe(false)
    const ncId = bad.data.nonconformity_id
    expect((await post(`/api/nonconformities/${ncId}/status`, o.token, { status: 'closed' })).data.error.code).toBe('no_corrective_action')
    const ac = await post('/api/corrective-actions', o.token, { nonconformity_id: ncId, description: 'Chamar manutenção' })
    expect(ac.status).toBe(201)
    expect((await post(`/api/nonconformities/${ncId}/status`, o.token, { status: 'closed' })).data.error.code).toBe('pending_actions')
    await post(`/api/corrective-actions/${ac.data.id}/complete`, o.token)
    expect((await post(`/api/nonconformities/${ncId}/status`, o.token, { status: 'closed' })).status).toBe(200)
    const d = await get('/api/dashboard/quality', o.token)
    expect(d.data.temperature_last_30d.out_of_range).toBe(1); expect(d.data.open_nonconformities).toBe(0)
  })
  it('checklist calcula nota e abre NC crítica para item crítico', async () => {
    const { o, u } = await setup()
    const t = await post('/api/checklist-templates', o.token, { name: 'BPF', items: [{ id: 'a', text: 'Mãos higienizadas', critical: true }, { id: 'b', text: 'Piso limpo' }] })
    expect(t.status).toBe(201)
    expect((await post('/api/checklist-runs', o.token, { unit_id: u, template_id: t.data.id, answers: [{ item_id: 'a', ok: true }] })).status).toBe(400)
    const r = await post('/api/checklist-runs', o.token, { unit_id: u, template_id: t.data.id, answers: [{ item_id: 'a', ok: false }, { item_id: 'b', ok: true }] })
    expect(r.data.score).toBe(50)
    const nc = await get('/api/nonconformities', o.token)
    expect(nc.data.items[0].severity).toBe('critical')
  })
  it('recebimento recusado exige justificativa e abre NC; isolamento', async () => {
    const { o, u } = await setup(); const b = await newOrg()
    expect((await post('/api/receiving-records', o.token, { unit_id: u, product: 'Frango', accepted: false })).data.error.code).toBe('notes_required')
    const r = await post('/api/receiving-records', o.token, { unit_id: u, product: 'Frango', accepted: false, notes: 'Temperatura 12°C' })
    expect(r.data.nonconformity_id).toBeTruthy()
    expect((await get('/api/nonconformities', b.token)).data.items.length).toBe(0)
    expect((await post('/api/receiving-records', b.token, { unit_id: u, product: 'x' })).status).toBe(404)
  })
})

describe('agenda', () => {
  it('cria evento, valida vínculo e o job gera lembrete', async () => {
    const { o } = await setup()
    const start = new Date(Date.now() + 20 * 60000).toISOString()
    expect((await post('/api/events', o.token, { title: 'x', starts_at: start, related_type: 'athlete', related_id: 'inexistente' })).status).toBe(400)
    const e = await post('/api/events', o.token, { title: 'Consulta', kind: 'consulta', starts_at: start, reminder_minutes: 30, participants: [o.userId] })
    expect(e.status).toBe(201)
    const r1 = await runDueJobs(env as any); expect(r1.reminders).toBeGreaterThanOrEqual(1)
    expect((await runDueJobs(env as any)).reminders).toBe(0) // sem duplicar
    const n = await get('/api/notifications', o.token)
    expect(JSON.stringify(n.data)).toContain('Lembrete: Consulta')
  })
})

describe('IA assistiva', () => {
  it('desligada por padrão; ao ligar sugere substituição, exige revisão humana e registra auditoria', async () => {
    const { o } = await setup()
    const a1 = await food(o.token, 'Arroz branco'), a2 = await food(o.token, 'Arroz integral', { energy_kcal: 110, allergens: ['Gluten'] }), a3 = await food(o.token, 'Quinoa', { energy_kcal: 120 })
    const rc = await post('/api/recipes', o.token, { name: 'Prato', portions: 4, yield_g: 400, items: [{ food_id: a1, net_g: 400 }] })
    const body = { recipe_id: rc.data.id, food_id: a1, avoid_allergens: ['gluten'] }
    expect((await post('/api/ai/suggest/substitution', o.token, body)).status).toBe(403)
    await put('/api/org', o.token, { ai_enabled: true })
    const s = await post('/api/ai/suggest/substitution', o.token, body)
    expect(s.status).toBe(201)
    expect(s.data.data_sent_externally).toBe(false)
    expect(s.data.candidates.map((c: any) => c.food_id)).toEqual([a3]) // integral excluído por alérgeno
    expect(s.data.disclosure).toContain('validação')
    expect((await post(`/api/ai/suggestions/${s.data.id}/review`, o.token, { decision: 'accepted' })).status).toBe(200)
    expect((await post(`/api/ai/suggestions/${s.data.id}/review`, o.token, { decision: 'rejected' })).status).toBe(409)
    const est = await userWithRole(o.token, 'estoquista')
    expect((await get('/api/ai/suggestions', est.token)).status).toBeGreaterThanOrEqual(403)
  })
})

describe('portal', () => {
  it('atleta vê apenas os próprios dados e registra diário', async () => {
    const { o } = await setup()
    const rid = await roleId(o.token, 'paciente_portal')
    const email = 'atl-' + crypto.randomUUID().slice(0, 6) + '@teste.dev'
    const cu = await post('/api/users', o.token, { email, name: 'Atleta Portal', password: PW, role_id: rid })
    expect(cu.status).toBe(201)
    const mine = await post('/api/athletes', o.token, { name: 'Atleta Portal', user_id: cu.data.user_id }), other = await post('/api/athletes', o.token, { name: 'Outro' })
    const tok = (await post('/api/auth/login', undefined, { email, password: PW })).data.token
    const me = await get('/api/portal/me', tok)
    expect(me.data.name).toBe('Atleta Portal')
    expect((await post('/api/portal/diary', tok, { date: '2026-07-01', meal_name: 'Almoço', description: 'Arroz e feijão' })).status).toBe(201)
    expect((await get(`/api/athletes/${other.data.id}`, tok)).status).toBeGreaterThanOrEqual(403)
    expect((await get('/api/foods', tok)).status).toBeGreaterThanOrEqual(403)
    expect((await get(`/api/food-diary?subject_type=athlete&subject_id=${mine.data.id}`, o.token)).data.items.length).toBe(1)
  })
})

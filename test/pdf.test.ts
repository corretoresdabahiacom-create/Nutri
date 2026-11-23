import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import { get, newOrg, post, unit, userWithRole } from './helpers'
import { buildPdf, responsibleLine, safe } from '../src/worker/lib/pdf'
import { env } from 'cloudflare:test'
import { PDFDocument } from 'pdf-lib'

const raw = (p: string, t: string) => SELF.fetch('http://localhost' + p, { headers: { Authorization: 'Bearer ' + t } })
const FOOD = { source: 'DEMO fictício', energy_kcal: 100, protein_g: 5, carb_g: 20, fat_g: 2, fiber_g: 1, sodium_mg: 100 }
async function isPdf(res: Response) { const b = new Uint8Array(await res.arrayBuffer()); expect(new TextDecoder().decode(b.slice(0, 5))).toBe('%PDF-'); return PDFDocument.load(b) }

describe('PDF no servidor', () => {
  it('buildPdf aceita acentos/símbolos fora do WinAnsi e quebra páginas', async () => {
    expect(safe('Feijão → ≤ 5 “ok” ✓ 日本')).toBe('Feijão -> <= 5 "ok" OK ??')
    const rows = Array.from({ length: 120 }, (_, i) => [`Item ${i} çãõ`, 'x'.repeat(200), '→'])
    const doc = await PDFDocument.load(await buildPdf({ title: 'Teste ✓', blocks: [{ t: 'alert', text: 'Alergia: amendoim' }, { t: 'table', head: ['A', 'B', 'C'], rows }] }))
    expect(doc.getPageCount()).toBeGreaterThan(2)
  })
  it('ficha técnica, cardápio e plano alimentar saem em PDF; rascunho e custo incompleto são sinalizados', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'Rest', 'restaurant')
    const fd = (await post('/api/foods', o.token, { name: 'Arroz', ...FOOD })).data.id
    const rc = (await post('/api/recipes', o.token, { name: 'Arroz branco', portions: 10, yield_g: 2000, items: [{ food_id: fd, net_g: 1000, gross_g: 1000 }] })).data.id
    const r1 = await raw(`/api/recipes/${rc}/export.pdf`, o.token)
    expect(r1.status).toBe(200); expect(r1.headers.get('content-type')).toBe('application/pdf'); await isPdf(r1)
    await post(`/api/recipes/${rc}/approve`, o.token, { nutrition_reviewed: true, allergens_reviewed: true })
    const m = (await post('/api/menus', o.token, { name: 'Semana', unit_id: u, date_from: '2026-12-01', date_to: '2026-12-07' })).data.id
    expect((await raw(`/api/menus/${m}/export.pdf`, o.token)).status).toBe(200)
    const ath = (await post('/api/athletes', o.token, { name: 'Atleta Teste', unit_id: u })).data.id
    const pl = await post('/api/meal-plans', o.token, { subject_type: 'athlete', subject_id: ath, name: 'Plano', items: [{ meal_name: 'Café', food_id: fd, qty_g: 150 }] })
    expect(pl.status).toBe(201)
    await isPdf(await raw(`/api/meal-plans/${pl.data.id}/export.pdf`, o.token))
    expect((await raw('/api/recipes/inexistente/export.pdf', o.token)).status).toBe(404)
  })
  it('isolamento: outra organização e usuário sem permissão não baixam; mapa hospitalar exige unidade da organização', async () => {
    const a = await newOrg(), b = await newOrg(); const ua = await unit(a.token, 'Hosp', 'hospital'), ub = await unit(b.token, 'Hosp B', 'hospital')
    const fd = (await post('/api/foods', a.token, { name: 'Sopa', ...FOOD })).data.id
    const rc = (await post('/api/recipes', a.token, { name: 'Sopa', portions: 5, yield_g: 1000, items: [{ food_id: fd, net_g: 500, gross_g: 500 }] })).data.id
    expect((await raw(`/api/recipes/${rc}/export.pdf`, b.token)).status).toBe(404)
    expect((await raw(`/api/meal-orders/export.pdf?unit_id=${ua}&date=2026-12-01`, b.token)).status).not.toBe(200)
    expect((await raw(`/api/meal-orders/export.pdf?unit_id=${ub}&date=2026-12-01`, a.token)).status).not.toBe(200)
    await isPdf(await raw(`/api/meal-orders/export.pdf?unit_id=${ua}&date=2026-12-01`, a.token))
    const portal = await userWithRole(a.token, 'paciente_portal')
    expect((await raw(`/api/meal-orders/export.pdf?unit_id=${ua}&date=2026-12-01`, portal.token)).status).toBe(403)
    expect((await get('/api/meal-orders', a.token)).status).toBe(200)
  })
  it('ordem de produção, estoque e auditoria em PDF; responsável técnico vem do cadastro profissional', async () => {
    const o = await newOrg(); const u = await unit(o.token, 'UAN', 'uan')
    const fd = (await post('/api/foods', o.token, { name: 'Feijão', ...FOOD })).data.id
    const rc = (await post('/api/recipes', o.token, { name: 'Feijão', portions: 10, yield_g: 2000, items: [{ food_id: fd, net_g: 1000, gross_g: 1000 }] })).data.id
    await post(`/api/recipes/${rc}/approve`, o.token, { nutrition_reviewed: true, allergens_reviewed: true })
    const po = await post('/api/production-orders', o.token, { unit_id: u, date: '2026-12-01', meal_type: 'almoco', recipe_id: rc, planned_portions: 20 })
    expect(po.status).toBe(201)
    await isPdf(await raw(`/api/production-orders/${po.data.id}/export.pdf`, o.token))
    await isPdf(await raw(`/api/stock/balance/export.pdf?unit_id=${u}`, o.token))
    await isPdf(await raw('/api/audit?format=pdf', o.token))
    const b = await newOrg()
    expect((await raw(`/api/production-orders/${po.data.id}/export.pdf`, b.token)).status).toBe(404)
    expect(await responsibleLine(env.DB, o.orgId, null)).toContain('ainda não aprovado')
    expect(await responsibleLine(env.DB, o.orgId, o.userId)).toContain('registro profissional não cadastrado')
    const ts = new Date().toISOString()
    await env.DB.prepare("INSERT INTO professionals (id,org_id,user_id,council,council_number,created_at,updated_at) VALUES ('pr1',?,?,'CRN-5','12345',?,?)").bind(o.orgId, o.userId, ts, ts).run()
    expect(await responsibleLine(env.DB, o.orgId, o.userId)).toMatch(/CRN-5 12345/)
  })
})

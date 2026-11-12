import { Hono } from 'hono'
import { type AppEnv, audit, rateLimit } from '../lib/auth'
import { decryptValue, encryptValue, sha256Hex } from '../lib/crypto'
import { type Env, HttpError, bad, nowIso, parseJson, readBody, uid } from '../lib/util'

/** Endpoints públicos autenticados por token de integração (Bearer nvi_…): PDV, balança, PMS hoteleiro e HIS (FHIR). */
export const inbound = new Hono<AppEnv>()
const DATE = /^\d{4}-\d{2}-\d{2}$/

interface Tok { id: string; org_id: string; unit_id: string | null; kind: string }
async function tokenAuth(c: any, kind: string): Promise<Tok> {
  const h = c.req.header('Authorization') ?? ''
  const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  if (!raw.startsWith('nvi_')) throw new HttpError(401, 'unauthorized', 'Token de integração ausente')
  const t = await (c.env as Env).DB.prepare('SELECT id,org_id,unit_id,kind FROM integration_tokens WHERE token_hash=? AND active=1').bind(await sha256Hex(raw)).first<Tok>()
  if (!t || t.kind !== kind) throw new HttpError(401, 'unauthorized', 'Token inválido')
  if (!(await rateLimit(c.env, 'itok:' + t.id, 600, 60))) throw new HttpError(429, 'rate_limited', 'Limite de requisições excedido')
  await (c.env as Env).DB.prepare('UPDATE integration_tokens SET last_used_at=? WHERE id=?').bind(nowIso(), t.id).run()
  return t
}
async function unitFor(c: any, t: Tok, wanted: unknown): Promise<string> {
  const id = String(wanted ?? t.unit_id ?? '')
  if (t.unit_id && id !== t.unit_id) throw new HttpError(403, 'forbidden', 'Token restrito a outra unidade')
  if (!id || !(await (c.env as Env).DB.prepare('SELECT 1 FROM units WHERE id=? AND org_id=?').bind(id, t.org_id).first())) throw bad('invalid_unit', 'unit_id inválido')
  return id
}
const auditIn = (c: any, t: Tok, action: string, entity: string, meta: Record<string, unknown>) =>
  audit({ env: c.env, auth: null, ip: c.req.header('CF-Connecting-IP') ?? undefined } as any, action, entity, t.id, { org: t.org_id, ...meta }).catch(() => {})

inbound.post('/inbound/pdv', async (c) => {
  const t = await tokenAuth(c, 'pdv'), b = await readBody(c), unit = await unitFor(c, t, b.unit_id)
  const rows: any[] = Array.isArray(b.rows) ? b.rows : []
  if (!rows.length || rows.length > 2000) throw bad('invalid_field', 'rows (1..2000): {date, recipe_id|recipe_name, qty, revenue}')
  const ok: any[] = [], errors: any[] = []
  for (const [i, r] of rows.entries()) {
    const rec = r.recipe_id ? await c.env.DB.prepare('SELECT id FROM recipes WHERE id=? AND org_id=?').bind(r.recipe_id, t.org_id).first<any>()
      : await c.env.DB.prepare("SELECT id FROM recipes WHERE org_id=? AND name=? AND status='approved' LIMIT 1").bind(t.org_id, String(r.recipe_name ?? '')).first<any>()
    if (!rec || !DATE.test(String(r.date)) || !(Number(r.qty) > 0) || !(Number(r.revenue) >= 0)) { errors.push({ row: i + 1, error: 'linha inválida ou receita não encontrada' }); continue }
    ok.push({ ...r, recipe_id: rec.id })
  }
  const ts = nowIso()
  for (let i = 0; i < ok.length; i += 50) await c.env.DB.batch(ok.slice(i, i + 50).map((r) => c.env.DB.prepare("INSERT INTO sales (id,org_id,unit_id,date,recipe_id,qty,revenue,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pdv',?,?)").bind(uid(), t.org_id, unit, r.date, r.recipe_id, Number(r.qty), Number(r.revenue), ts, ts)))
  await auditIn(c, t, 'import', 'sales', { imported: ok.length, skipped: errors.length, source: 'pdv' })
  return c.json({ imported: ok.length, skipped: errors.length, errors: errors.slice(0, 50) }, errors.length && !ok.length ? 422 : 201)
})

inbound.post('/inbound/pms', async (c) => {
  const t = await tokenAuth(c, 'hotel_pms'), b = await readBody(c), unit = await unitFor(c, t, b.unit_id)
  const days: any[] = Array.isArray(b.days) ? b.days : []
  if (!days.length || days.length > 366) throw bad('invalid_field', 'days (1..366): {date, rooms_occupied, adults, children}')
  const bad_: number[] = [], ts = nowIso(), stmts = []
  for (const [i, d] of days.entries()) {
    if (!DATE.test(String(d.date)) || !(Number(d.adults ?? 0) >= 0) || !(Number(d.children ?? 0) >= 0)) { bad_.push(i + 1); continue }
    stmts.push(c.env.DB.prepare("INSERT INTO occupancy_forecasts (id,org_id,unit_id,date,rooms_occupied,adults,children,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pms',?,?) ON CONFLICT(org_id,unit_id,date) DO UPDATE SET rooms_occupied=excluded.rooms_occupied,adults=excluded.adults,children=excluded.children,source='pms',updated_at=excluded.updated_at")
      .bind(uid(), t.org_id, unit, d.date, d.rooms_occupied == null ? null : Number(d.rooms_occupied), Number(d.adults ?? 0), Number(d.children ?? 0), ts, ts))
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50))
  await auditIn(c, t, 'import', 'occupancy_forecasts', { upserted: stmts.length, source: 'pms' })
  return c.json({ upserted: stmts.length, invalid_rows: bad_ }, 201)
})

const SCALE_KINDS = ['recebimento', 'desperdicio', 'sobra', 'porcao', 'producao']
inbound.post('/inbound/scale', async (c) => {
  const t = await tokenAuth(c, 'scale'), b = await readBody(c), unit = await unitFor(c, t, b.unit_id)
  const readings: any[] = Array.isArray(b.readings) ? b.readings : []
  if (!readings.length || readings.length > 500) throw bad('invalid_field', 'readings (1..500): {kind, weight_g, tare_g?, food_id?, lot_code?, recorded_at?}')
  const ts = nowIso(), out: any[] = [], errors: any[] = []
  for (const [i, r] of readings.entries()) {
    const w = Number(r.weight_g), tare = Number(r.tare_g ?? 0)
    if (!SCALE_KINDS.includes(String(r.kind)) || !(w > 0) || !(tare >= 0) || tare >= w) { errors.push({ row: i + 1, error: 'kind/peso/tara inválidos' }); continue }
    if (r.food_id && !(await c.env.DB.prepare('SELECT 1 FROM foods WHERE id=? AND (org_id=? OR org_id IS NULL)').bind(r.food_id, t.org_id).first())) { errors.push({ row: i + 1, error: 'food_id inválido' }); continue }
    const net = Math.round((w - tare) * 100) / 100, id = uid(), at = r.recorded_at && !isNaN(Date.parse(r.recorded_at)) ? new Date(r.recorded_at).toISOString() : ts
    let wasteId: string | null = null
    if ((r.kind === 'desperdicio' || r.kind === 'sobra') && r.food_id) {
      wasteId = uid()
      await c.env.DB.prepare('INSERT INTO waste_records (id,org_id,unit_id,date,kind,food_id,qty_g,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .bind(wasteId, t.org_id, unit, at.slice(0, 10), r.kind === 'desperdicio' ? 'desperdicio' : 'sobra_limpa', r.food_id, net, `Balança ${b.device ?? ''}`.trim(), ts, ts).run()
    }
    await c.env.DB.prepare('INSERT INTO scale_readings (id,org_id,unit_id,device,kind,food_id,lot_code,weight_g,tare_g,net_g,recorded_at,waste_record_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, t.org_id, unit, b.device ? String(b.device).slice(0, 60) : null, r.kind, r.food_id ?? null, r.lot_code ? String(r.lot_code).slice(0, 60) : null, w, tare, net, at, wasteId, ts).run()
    out.push({ id, net_g: net, waste_record_id: wasteId })
  }
  await auditIn(c, t, 'import', 'scale_readings', { accepted: out.length, rejected: errors.length })
  return c.json({ accepted: out, rejected: errors }, out.length ? 201 : 422)
})

/** Entrada HIS: Bundle FHIR R4 com Patient e AllergyIntolerance. Atualiza só dados cadastrais e alergias; não toca prescrições. */
inbound.post('/inbound/his/fhir', async (c) => {
  const t = await tokenAuth(c, 'hospital_his'), b = await readBody(c), unit = await unitFor(c, t, c.req.query('unit_id') ?? b.unit_id)
  if (b.resourceType !== 'Bundle' || !Array.isArray(b.entry)) throw bad('invalid_fhir', 'Envie um Bundle FHIR R4 com entry[]')
  if (b.entry.length > 500) throw bad('too_many', 'Máximo de 500 recursos por Bundle')
  const patientsByRef = new Map<string, string>()
  const result = { created: 0, updated: 0, allergies_added: 0, skipped: [] as any[] }
  const ts = nowIso()
  for (const e of b.entry) {
    const r = e.resource
    if (r?.resourceType !== 'Patient') continue
    const code = String(r.identifier?.[0]?.value ?? '').trim()
    const nm = r.name?.[0], name = String(nm?.text ?? [...(nm?.given ?? []), nm?.family].filter(Boolean).join(' ')).trim()
    if (!code || !name) { result.skipped.push({ id: r.id, reason: 'Patient sem identifier.value ou name' }); continue }
    const sex = r.gender ? String(r.gender).slice(0, 20) : null, birth = DATE.test(String(r.birthDate ?? '')) ? r.birthDate : null
    const ex = await c.env.DB.prepare('SELECT id FROM patients WHERE org_id=? AND internal_code=?').bind(t.org_id, code).first<any>()
    let id: string
    if (ex) {
      id = ex.id
      await c.env.DB.prepare('UPDATE patients SET name=?, birth_date=COALESCE(?,birth_date), sex=COALESCE(?,sex), updated_at=? WHERE id=?').bind(name, birth, sex, ts, id).run()
      result.updated++
    } else {
      id = uid()
      await c.env.DB.prepare("INSERT INTO patients (id,org_id,unit_id,internal_code,name,birth_date,sex,admission_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'admitted',?,?)").bind(id, t.org_id, unit, code, name, birth, sex, ts.slice(0, 10), ts, ts).run()
      result.created++
    }
    if (r.id) patientsByRef.set(`Patient/${r.id}`, id)
  }
  for (const e of b.entry) {
    const r = e.resource
    if (r?.resourceType !== 'AllergyIntolerance') continue
    const pid = patientsByRef.get(String(r.patient?.reference ?? '')), label = String(r.code?.text ?? r.code?.coding?.[0]?.display ?? '').trim()
    if (!pid || !label) { result.skipped.push({ id: r.id, reason: 'AllergyIntolerance sem paciente conhecido no Bundle ou sem code.text' }); continue }
    const row = await c.env.DB.prepare('SELECT allergies FROM patients WHERE id=?').bind(pid).first<any>()
    const cur = (await decryptValue<string[]>(c.env, row?.allergies, `patients.allergies.${pid}`)) ?? []
    if (cur.some((x) => x.toLowerCase() === label.toLowerCase())) continue
    await c.env.DB.prepare('UPDATE patients SET allergies=?, updated_at=? WHERE id=?').bind(await encryptValue(c.env, [...cur, label], `patients.allergies.${pid}`), ts, pid).run()
    result.allergies_added++
  }
  await auditIn(c, t, 'import', 'patients', { created: result.created, updated: result.updated, allergies: result.allergies_added, source: 'his_fhir' })
  return c.json(result, 201)
})

// ---------- feed ICS (público, por token do usuário) ----------
export const publicCalendar = new Hono<AppEnv>()
const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
publicCalendar.get('/public/calendar/:file', async (c) => {
  const raw = c.req.param('file').replace(/\.ics$/, '')
  const t = await c.env.DB.prepare("SELECT id,org_id,user_id FROM integration_tokens WHERE token_hash=? AND kind='ics' AND active=1").bind(await sha256Hex(raw)).first<any>()
  if (!t) return c.json({ error: { code: 'not_found', message: 'Feed não encontrado' } }, 404)
  if (!(await rateLimit(c.env, 'ics:' + t.id, 120, 3600))) return c.json({ error: { code: 'rate_limited', message: 'Muitas requisições' } }, 429)
  await c.env.DB.prepare('UPDATE integration_tokens SET last_used_at=? WHERE id=?').bind(nowIso(), t.id).run()
  const rows = (await c.env.DB.prepare("SELECT id,title,kind,starts_at,ends_at,participants,owner_user_id,updated_at FROM events WHERE org_id=? AND status!='cancelled' AND starts_at>=? ORDER BY starts_at LIMIT 500").bind(t.org_id, new Date(Date.now() - 30 * 864e5).toISOString()).all<any>()).results
  const mine = rows.filter((e) => e.owner_user_id === t.user_id || parseJson<string[]>(e.participants, []).includes(t.user_id))
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NutriVida Pro//PT-BR//', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:NutriVida Pro']
  for (const e of mine) {
    const end = e.ends_at ?? new Date(Date.parse(e.starts_at) + 3600_000).toISOString()
    lines.push('BEGIN:VEVENT', `UID:${e.id}@nutrivida`, `DTSTAMP:${icsDate(e.updated_at ?? e.starts_at)}`, `DTSTART:${icsDate(e.starts_at)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEsc(e.title)}`, `CATEGORIES:${icsEsc(e.kind ?? 'outro')}`, 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return new Response(lines.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' } })
})

import { Hono } from 'hono'
import { type AppEnv, audit, need, needAny, requireUnit } from '../lib/auth'
import { encryptValue, randomToken, sha256Hex } from '../lib/crypto'
import { deliver, integrationConfig, safeWebhookUrl, sendEmail, sendWebhook, sendWhatsapp } from '../lib/outbound'
import { HttpError, bad, nowIso, notFound, readBody, uid } from '../lib/util'

export const integrationsRoutes = new Hono<AppEnv>()

/** Integrações configuráveis (credenciais do cliente, cifradas) e integrações de entrada (token). `implemented` reflete o que existe de fato. */
const CONFIGURABLE: Record<string, string[]> = { email: ['api_key', 'from'], whatsapp_business: ['token', 'phone_id'], erp_webhook: ['url', 'secret'] }
const INBOUND = ['pdv', 'scale', 'hotel_pms', 'hospital_his']
const NOT_IMPLEMENTED: Record<string, string> = {
  google_calendar: 'Sincronização OAuth com Google Agenda não implementada. Use o feed ICS (assinatura de calendário), que funciona no Google Agenda.',
  billing: 'Cobrança recorrente não implementada (sem gateway). Nenhuma transação é simulada.'
}

integrationsRoutes.get('/integrations', need('integrations.manage'), async (c) => {
  const a = c.get('auth')
  const rows = (await c.env.DB.prepare('SELECT kind,status,updated_at FROM integrations WHERE org_id=?').bind(a.orgId).all<any>()).results
  const m = new Map(rows.map((r) => [r.kind, r]))
  const tok = (await c.env.DB.prepare('SELECT kind,COUNT(*) n FROM integration_tokens WHERE org_id=? AND active=1 GROUP BY kind').bind(a.orgId).all<any>()).results
  const tm = new Map(tok.map((t) => [t.kind, t.n]))
  const items = [
    ...Object.keys(CONFIGURABLE).map((k) => ({ kind: k, implemented: true, mode: 'saida', status: m.get(k)?.status ?? 'not_configured', fields: CONFIGURABLE[k] })),
    ...INBOUND.map((k) => ({ kind: k, implemented: true, mode: 'entrada', status: (tm.get(k) ?? 0) > 0 ? 'active' : 'not_configured', active_tokens: tm.get(k) ?? 0 })),
    { kind: 'calendar_ics', implemented: true, mode: 'feed', status: 'per_user' },
    ...Object.entries(NOT_IMPLEMENTED).map(([k, note]) => ({ kind: k, implemented: false, status: 'not_implemented', note }))
  ]
  return c.json({ items })
})

integrationsRoutes.put('/integrations/:kind', need('integrations.manage'), async (c) => {
  const a = c.get('auth'), kind = c.req.param('kind'), b = await readBody(c)
  const need_ = CONFIGURABLE[kind]
  if (!need_) throw notFound('Integração configurável')
  const cfg: Record<string, any> = b.config ?? {}
  for (const k of need_) if (!String(cfg[k] ?? '').trim()) throw bad('invalid_field', `config.${k} é obrigatório`)
  if (kind === 'erp_webhook') { try { safeWebhookUrl(String(cfg.url)) } catch (e) { throw bad('invalid_url', (e as Error).message) } }
  if (kind === 'email' && !/^([^<>@]*<[^@\s<>]+@[^@\s<>]+>|[^@\s<>]+@[^@\s<>]+)$/.test(String(cfg.from).trim())) throw bad('invalid_field', 'config.from inválido')
  const enc = await encryptValue(c.env, cfg, `integrations.config_enc.${a.orgId}.${kind}`)
  const ts = nowIso()
  await c.env.DB.prepare('INSERT INTO integrations (id,org_id,kind,status,config_enc,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id,kind) DO UPDATE SET config_enc=excluded.config_enc,status=excluded.status,updated_at=excluded.updated_at')
    .bind(uid(), a.orgId, kind, 'configured_unverified', enc, ts, ts).run()
  await audit(c, 'configure', 'integrations', kind)
  return c.json({ ok: true, status: 'configured_unverified', note: 'Use /integrations/:kind/test para verificar com o provedor.' })
})

integrationsRoutes.delete('/integrations/:kind', need('integrations.manage'), async (c) => {
  const a = c.get('auth'), kind = c.req.param('kind')
  if (!CONFIGURABLE[kind]) throw notFound('Integração configurável')
  await c.env.DB.prepare('DELETE FROM integrations WHERE org_id=? AND kind=?').bind(a.orgId, kind).run()
  await audit(c, 'remove', 'integrations', kind)
  return c.json({ ok: true })
})

/** Teste real: só marca "verified" se o provedor responder 2xx. */
integrationsRoutes.post('/integrations/:kind/test', need('integrations.manage'), async (c) => {
  const a = c.get('auth'), kind = c.req.param('kind'), b = await readBody(c)
  if (!CONFIGURABLE[kind]) throw notFound('Integração configurável')
  const cfg = await integrationConfig(c.env, a.orgId!, kind)
  let r
  if (kind === 'email') r = await sendEmail(c.env, a.orgId!, { to: String(b.to ?? ''), subject: 'Teste NutriVida Pro', text: 'Mensagem de teste da integração de e-mail.' })
  else if (kind === 'whatsapp_business') r = await sendWhatsapp(c.env, a.orgId!, b.template ? { to: String(b.to ?? ''), template: b.template } : { to: String(b.to ?? ''), text: 'Teste NutriVida Pro' })
  else r = await sendWebhook(c.env, a.orgId!, 'ping', { message: 'teste' }, uid())
  if (r.status === 'not_configured' && !cfg) throw new HttpError(424, 'integration_not_configured', r.error)
  await c.env.DB.prepare('UPDATE integrations SET status=?, updated_at=? WHERE org_id=? AND kind=?').bind(r.ok ? 'verified' : 'configured_unverified', nowIso(), a.orgId, kind).run()
  await audit(c, 'test', 'integrations', kind, { ok: r.ok })
  if (!r.ok) throw new HttpError(502, 'delivery_failed', `Teste falhou: ${r.error}`)
  return c.json({ ok: true, status: 'verified', provider: r.provider })
})

// ---------- tokens de entrada (o token completo é mostrado uma única vez) ----------
integrationsRoutes.post('/integration-tokens', need('integrations.manage'), async (c) => {
  const a = c.get('auth'), b = await readBody(c)
  const kind = String(b.kind ?? '')
  if (!INBOUND.includes(kind)) throw bad('invalid_field', `kind deve ser: ${INBOUND.join(', ')}`)
  const unit = b.unit_id ? await requireUnit(c, 'integrations.manage', b.unit_id) : null
  const token = 'nvi_' + randomToken(32), id = uid()
  await c.env.DB.prepare('INSERT INTO integration_tokens (id,org_id,kind,token_hash,label,unit_id,active,created_by,created_at) VALUES (?,?,?,?,?,?,1,?,?)')
    .bind(id, a.orgId, kind, await sha256Hex(token), b.label ? String(b.label).slice(0, 80) : null, unit, a.userId, nowIso()).run()
  await audit(c, 'create', 'integration_tokens', id, { kind })
  return c.json({ id, kind, token, note: 'Guarde o token agora: ele não pode ser exibido novamente.' }, 201)
})
integrationsRoutes.get('/integration-tokens', need('integrations.manage'), async (c) => {
  const r = await c.env.DB.prepare("SELECT id,kind,label,unit_id,active,last_used_at,created_at FROM integration_tokens WHERE org_id=? AND kind!='ics' ORDER BY created_at DESC").bind(c.get('auth').orgId).all<any>()
  return c.json({ items: r.results })
})
integrationsRoutes.delete('/integration-tokens/:id', need('integrations.manage'), async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare('UPDATE integration_tokens SET active=0 WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).run()
  if (!r.meta.changes) throw notFound('Token')
  await audit(c, 'revoke', 'integration_tokens', c.req.param('id'))
  return c.json({ ok: true })
})

// ---------- caixa de saída ----------
integrationsRoutes.get('/outbox', need('integrations.manage'), async (c) => {
  const r = await c.env.DB.prepare('SELECT id,channel,to_addr,subject,status,provider,error,attempts,related_type,related_id,created_at,sent_at FROM outbound_messages WHERE org_id=? ORDER BY created_at DESC LIMIT 200').bind(c.get('auth').orgId).all<any>()
  return c.json({ items: r.results })
})
integrationsRoutes.post('/outbox/:id/retry', need('integrations.manage'), async (c) => {
  const a = c.get('auth')
  const m = await c.env.DB.prepare('SELECT id,status FROM outbound_messages WHERE id=? AND org_id=?').bind(c.req.param('id'), a.orgId).first<any>()
  if (!m) throw notFound('Mensagem')
  if (m.status === 'sent') throw bad('already_sent', 'Mensagem já enviada')
  return c.json(await deliver(c.env, m.id))
})

// ---------- feed de agenda (ICS) por usuário ----------
integrationsRoutes.post('/calendar-feed', needAny('events.read'), async (c) => {
  const a = c.get('auth')
  await c.env.DB.prepare("UPDATE integration_tokens SET active=0 WHERE org_id=? AND user_id=? AND kind='ics'").bind(a.orgId, a.userId).run()
  const token = 'nvc_' + randomToken(32)
  await c.env.DB.prepare("INSERT INTO integration_tokens (id,org_id,kind,token_hash,user_id,active,created_by,created_at) VALUES (?,?,'ics',?,?,1,?,?)").bind(uid(), a.orgId, await sha256Hex(token), a.userId, a.userId, nowIso()).run()
  await audit(c, 'create', 'calendar_feed', undefined)
  return c.json({ url_path: `/api/public/calendar/${token}.ics`, note: 'Assine esta URL no Google Agenda/Outlook. Gerar outro link revoga o anterior.' }, 201)
})

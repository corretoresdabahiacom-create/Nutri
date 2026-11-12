import { decryptValue, hex } from './crypto'
import { type Env, nowIso, uid } from './util'

/** Entrega externa real. Nada é marcado como enviado sem confirmação 2xx do provedor; sem credenciais, o envio é recusado. */
export type Channel = 'email' | 'whatsapp' | 'webhook'
export interface SendResult { ok: boolean; status: 'sent' | 'failed' | 'not_configured'; provider?: string; ref?: string; error?: string }

export async function integrationConfig(env: Env, orgId: string, kind: string): Promise<Record<string, any> | null> {
  const row = await env.DB.prepare('SELECT config_enc FROM integrations WHERE org_id=? AND kind=?').bind(orgId, kind).first<any>()
  if (!row?.config_enc) return null
  return decryptValue<Record<string, any>>(env, row.config_enc, `integrations.config_enc.${orgId}.${kind}`)
}

/** Bloqueia destinos locais/privados (SSRF) e exige https. */
export function safeWebhookUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new Error('URL inválida') }
  const h = u.hostname.toLowerCase()
  if (u.protocol !== 'https:') throw new Error('Somente https é aceito')
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) throw new Error('Destino não permitido')
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) throw new Error('Destino não permitido')
  }
  if (h.startsWith('[') ) throw new Error('Destino não permitido')
  return u
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
}
export { hmacHex }

async function post(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 500) }
  } catch (e) { return { ok: false, status: 0, text: e instanceof Error ? e.message : 'falha de rede' } }
}

export async function sendEmail(env: Env, orgId: string, m: { to: string; subject: string; text: string; attachments?: { filename: string; content_b64: string }[] }): Promise<SendResult> {
  const cfg = await integrationConfig(env, orgId, 'email')
  const key = cfg?.api_key ?? env.RESEND_API_KEY, from = cfg?.from ?? env.EMAIL_FROM
  if (!key || !from) return { ok: false, status: 'not_configured', error: 'E-mail não configurado (api_key e from).' }
  const r = await post('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content_b64 })) })
  })
  if (!r.ok) return { ok: false, status: 'failed', provider: 'resend', error: `HTTP ${r.status}: ${r.text}` }
  let ref: string | undefined
  try { ref = JSON.parse(r.text).id } catch { /* ignore */ }
  return { ok: true, status: 'sent', provider: 'resend', ref }
}

export async function sendWhatsapp(env: Env, orgId: string, m: { to: string; text?: string; template?: { name: string; lang: string; params?: string[] } }): Promise<SendResult> {
  const cfg = await integrationConfig(env, orgId, 'whatsapp_business')
  const token = cfg?.token ?? env.WHATSAPP_TOKEN, phone = cfg?.phone_id ?? env.WHATSAPP_PHONE_ID
  if (!token || !phone) return { ok: false, status: 'not_configured', error: 'WhatsApp Business não configurado (token e phone_id).' }
  const to = m.to.replace(/\D/g, '')
  const body = m.template
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: m.template.name, language: { code: m.template.lang }, components: m.template.params?.length ? [{ type: 'body', parameters: m.template.params.map((t) => ({ type: 'text', text: t })) }] : undefined } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.text ?? '' } }
  const r = await post(`https://graph.facebook.com/v21.0/${encodeURIComponent(phone)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) return { ok: false, status: 'failed', provider: 'whatsapp_cloud', error: `HTTP ${r.status}: ${r.text}` }
  let ref: string | undefined
  try { ref = JSON.parse(r.text).messages?.[0]?.id } catch { /* ignore */ }
  return { ok: true, status: 'sent', provider: 'whatsapp_cloud', ref }
}

export async function sendWebhook(env: Env, orgId: string, event: string, payload: unknown, id: string): Promise<SendResult> {
  const cfg = await integrationConfig(env, orgId, 'erp_webhook')
  if (!cfg?.url || !cfg?.secret) return { ok: false, status: 'not_configured', error: 'Webhook não configurado (url e secret).' }
  if (Array.isArray(cfg.events) && cfg.events.length && !cfg.events.includes(event)) return { ok: false, status: 'not_configured', error: 'Evento não assinado' }
  let url: URL
  try { url = safeWebhookUrl(cfg.url) } catch (e) { return { ok: false, status: 'failed', error: (e as Error).message } }
  const body = JSON.stringify({ id, event, occurred_at: nowIso(), data: payload })
  const r = await post(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NutriVida-Event': event, 'X-NutriVida-Delivery': id, 'X-NutriVida-Signature': 'sha256=' + (await hmacHex(cfg.secret, body)) }, body })
  return r.ok ? { ok: true, status: 'sent', provider: 'webhook' } : { ok: false, status: 'failed', provider: 'webhook', error: `HTTP ${r.status}: ${r.text}` }
}

/** Registra evento para o ERP: só entra na fila se o webhook da organização estiver configurado e assinar o evento. */
export async function emitEvent(env: Env, orgId: string, event: string, data: unknown): Promise<void> {
  try {
    const cfg = await integrationConfig(env, orgId, 'erp_webhook')
    if (!cfg?.url || !cfg?.secret) return
    if (Array.isArray(cfg.events) && cfg.events.length && !cfg.events.includes(event)) return
    const id = uid(), ts = nowIso()
    await env.DB.prepare("INSERT INTO outbound_messages (id,org_id,channel,subject,payload,status,next_attempt_at,created_at,updated_at) VALUES (?,?,'webhook',?,?,'queued',?,?,?)")
      .bind(id, orgId, event, JSON.stringify(data), ts, ts, ts).run()
    await deliver(env, id)
  } catch (e) { console.error('emit_event_falhou', e instanceof Error ? e.message : String(e)) }
}

/** Tenta entregar uma mensagem da caixa de saída; atualiza status com o resultado real. Backoff exponencial, máx. 5 tentativas. */
export async function deliver(env: Env, id: string): Promise<SendResult> {
  const m = await env.DB.prepare('SELECT * FROM outbound_messages WHERE id=?').bind(id).first<any>()
  if (!m) return { ok: false, status: 'failed', error: 'não encontrada' }
  const p = m.payload ? JSON.parse(m.payload) : {}
  let r: SendResult
  if (m.channel === 'email') r = await sendEmail(env, m.org_id, { to: m.to_addr, subject: m.subject ?? '', text: m.body ?? '', attachments: p.attachments })
  else if (m.channel === 'whatsapp') r = await sendWhatsapp(env, m.org_id, { to: m.to_addr, text: m.body ?? undefined, template: p.template })
  else r = await sendWebhook(env, m.org_id, m.subject, p, m.id)
  const attempts = (m.attempts ?? 0) + 1, ts = nowIso()
  const retry = r.status === 'failed' && attempts < 5
  const next = retry ? new Date(Date.now() + 2 ** attempts * 60_000).toISOString() : null
  await env.DB.prepare('UPDATE outbound_messages SET status=?, provider=?, provider_ref=?, error=?, attempts=?, next_attempt_at=?, sent_at=?, updated_at=? WHERE id=?')
    .bind(r.status === 'failed' && retry ? 'queued' : r.status, r.provider ?? null, r.ref ?? null, r.error ?? null, attempts, next, r.ok ? ts : null, ts, id).run()
  return r
}

export async function retryOutbox(env: Env, limit = 20): Promise<number> {
  const due = (await env.DB.prepare("SELECT id FROM outbound_messages WHERE status='queued' AND next_attempt_at IS NOT NULL AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?").bind(nowIso(), limit).all<any>()).results
  for (const d of due) await deliver(env, d.id)
  return due.length
}

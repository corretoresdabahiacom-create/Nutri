import { retryOutbox } from './outbound'
import { type Env, nowIso, uid } from './util'

/** Rotinas periódicas (cron a cada 5 min): publicação agendada de cardápios, vencimento de validade e lembretes de agenda. */
/** Retenção de dados operacionais (não clínicos): sessões vencidas, limitadores, fila enviada e avisos lidos antigos. */
export async function purgeExpired(env: Env): Promise<Record<string, number>> {
  const now = nowIso(), d = (days: number) => new Date(Date.now() - days * 86400000).toISOString()
  const run = async (sql: string, ...p: unknown[]) => (await env.DB.prepare(sql).bind(...p).run()).meta.changes ?? 0
  return {
    sessions: await run('DELETE FROM sessions WHERE expires_at < ?', now),
    rate_limits: await run('DELETE FROM rate_limits WHERE window_start < ?', Math.floor(Date.now() / 1000) - 86400),
    outbound_sent: await run("DELETE FROM outbound_messages WHERE status='sent' AND created_at < ?", d(90)),
    notifications_read: await run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', d(180)),
    guest_links: await run('DELETE FROM guest_links WHERE expires_at < ?', d(30))
  }
}

export async function runDueJobs(env: Env, now = new Date()): Promise<{ published: number; expired: number; reminders: number; outbox_retried: number }> {
  const iso = now.toISOString()
  const pub = await env.DB.prepare("UPDATE menus SET status='published', updated_at=? WHERE status='scheduled' AND publish_at IS NOT NULL AND publish_at<=?").bind(iso, iso).run()
  const published = pub.meta.changes ?? 0
  const ex = await env.DB.prepare("UPDATE menus SET status='expired', updated_at=? WHERE status='published' AND valid_until IS NOT NULL AND valid_until<?").bind(iso, iso.slice(0, 10)).run()
  // lembretes de agenda: eventos que começam dentro da janela de lembrete e ainda não notificados
  const due = (await env.DB.prepare(
    "SELECT e.* FROM events e WHERE e.status='scheduled' AND e.reminder_minutes IS NOT NULL AND julianday(e.starts_at)<=julianday(?)+e.reminder_minutes/1440.0 AND julianday(e.starts_at)>=julianday(?) AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.ref_type='event' AND n.ref_id=e.id AND n.kind='reminder')"
  ).bind(iso, iso).all<any>()).results
  let reminders = 0
  for (const e of due) {
    const targets: string[] = [e.owner_user_id, ...JSON.parse(e.participants || '[]')].filter(Boolean)
    for (const u of new Set(targets)) {
      await env.DB.prepare("INSERT INTO notifications (id,org_id,user_id,title,body,kind,ref_type,ref_id,created_at,updated_at) VALUES (?,?,?,?,?,'reminder','event',?,?,?)").bind(uid(), e.org_id, u, `Lembrete: ${e.title}`, e.starts_at, e.id, nowIso(), nowIso()).run()
      reminders++
    }
    if (!targets.length) await env.DB.prepare("INSERT INTO notifications (id,org_id,user_id,title,body,kind,ref_type,ref_id,created_at,updated_at) VALUES (?,?,NULL,?,?,'reminder','event',?,?,?)").bind(uid(), e.org_id, `Lembrete: ${e.title}`, e.starts_at, e.id, nowIso(), nowIso()).run()
  }
  const outbox_retried = await retryOutbox(env).catch(() => 0)
  if (new Date().getUTCMinutes() < 5 && new Date().getUTCHours() === 5) await purgeExpired(env).catch(() => ({}))
  return { published, expired: ex.meta.changes ?? 0, reminders, outbox_retried }
}

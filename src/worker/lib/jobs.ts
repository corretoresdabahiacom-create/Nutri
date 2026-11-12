import { retryOutbox } from './outbound'
import { type Env, nowIso, uid } from './util'

/** Rotinas periódicas (cron a cada 5 min): publicação agendada de cardápios, vencimento de validade e lembretes de agenda. */
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
  return { published, expired: ex.meta.changes ?? 0, reminders, outbox_retried }
}

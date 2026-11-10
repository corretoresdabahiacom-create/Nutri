import { useState } from 'react'
import { get, post } from '../api'
import { Err, Page, today, useLoad } from '../ui'

export function Portal() {
  const me = useLoad(() => get('/portal/me'), [])
  const diary = useLoad(() => get('/portal/diary'), [])
  const [f, setF] = useState({ date: today(), meal_name: '', description: '' }), [err, setErr] = useState<unknown>(null)
  const add = async (e: React.FormEvent) => { e.preventDefault(); setErr(null); try { await post('/portal/diary', f); setF({ ...f, meal_name: '', description: '' }); diary.reload() } catch (x) { setErr(x) } }
  const d = me.data
  return (
    <Page title="Meu portal">
      <Err e={me.error ?? err} />
      {d && <div className="card"><h2 style={{ marginTop: 0 }}>Olá, {d.name}</h2>
        {d.approved_plan ? <p>Plano vigente: <b>{d.approved_plan.name}</b></p> : <p className="muted">Nenhum plano aprovado ainda.</p>}
        {d.goals?.length > 0 && <ul>{d.goals.map((g: any, i: number) => <li key={i}>{g.metric}: {g.current ?? '—'} / meta {g.target ?? '—'}</li>)}</ul>}
        {d.today_meals?.length > 0 && <><h2>Refeições de hoje</h2><ul>{d.today_meals.map((m: any, i: number) => <li key={i}>{m.meal_type}: {m.preparation ?? '—'} ({m.status})</li>)}</ul></>}
        {d.upcoming_appointments?.length > 0 && <><h2>Próximos atendimentos</h2><ul>{d.upcoming_appointments.map((a: any) => <li key={a.id}>{a.title} — {String(a.starts_at).slice(0, 16).replace('T', ' ')}</li>)}</ul></>}</div>}
      <form className="card form" onSubmit={add}><h2 style={{ gridColumn: '1/-1', margin: 0 }}>Diário alimentar</h2>
        <div className="field"><label>Data</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        <div className="field"><label>Refeição</label><input value={f.meal_name} onChange={(e) => setF({ ...f, meal_name: e.target.value })} required /></div>
        <div className="field"><label>O que comeu</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></div><div className="field"><label>&nbsp;</label><button type="submit">Registrar</button></div></form>
      <div className="tw"><table><thead><tr><th>Data</th><th>Refeição</th><th>Descrição</th></tr></thead><tbody>{(diary.data?.items ?? []).map((x: any) => <tr key={x.id}><td>{x.date}</td><td>{x.meal_name}</td><td>{x.description}</td></tr>)}</tbody></table></div>
    </Page>
  )
}

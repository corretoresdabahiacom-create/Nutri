import { useState } from 'react'
import { get, post } from '../api'
import { Badge, Err, Page, UnitSelect, today, useLoad, useMe } from '../ui'

export function MealOrders() {
  const { can } = useMe()
  const [unit, setUnit] = useState(''), [date, setDate] = useState(today()), [err, setErr] = useState<unknown>(null), [open, setOpen] = useState<any>(null), [note, setNote] = useState('')
  const { data, error, reload } = useLoad(() => (unit ? get(`/meal-orders?unit_id=${unit}&date=${date}`) : Promise.resolve({ items: [] })), [unit, date])
  const recipes = useLoad(() => get('/recipes?current=1'), [])
  const [gen, setGen] = useState({ meal_type: 'almoco', recipe_id: '' })
  const act = async (id: string, a: string, b?: unknown) => { setErr(null); try { await post(`/meal-orders/${id}/${a}`, b); reload() } catch (x) { setErr(x) } }
  const generate = async () => { setErr(null); try { await post('/meal-orders/generate', { unit_id: unit, date, meals: [gen] }); reload() } catch (x) { setErr(x) } }
  const swap = async (id: string, recipe_id: string) => { setErr(null); try { await (await import('../api')).put(`/meal-orders/${id}`, { recipe_id, reason: 'Substituição' }); reload() } catch (x) { setErr(x) } }
  return (
    <Page title="Pedidos de refeição (hospitalar)" actions={<button className="sec" onClick={() => window.print()}>Imprimir mapa</button>}>
      <div className="row no-print"><div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} kinds={['hospital', 'clinic']} /></div><input type="date" style={{ width: 160 }} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <Err e={error ?? err} />
      {can('hospital.prescribe') && <div className="card row no-print"><b>Gerar pedidos do dia:</b>
        <select style={{ width: 130 }} value={gen.meal_type} onChange={(e) => setGen({ ...gen, meal_type: e.target.value })}>{['cafe', 'colacao', 'almoco', 'lanche', 'jantar', 'ceia'].map((m) => <option key={m}>{m}</option>)}</select>
        <select style={{ width: 240 }} value={gen.recipe_id} onChange={(e) => setGen({ ...gen, recipe_id: e.target.value })}><option value="">Preparação (aprovada)</option>{(recipes.data?.items ?? []).filter((r: any) => r.status === 'approved').map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <button disabled={!gen.recipe_id || !unit} onClick={generate}>Gerar</button></div>}
      <div className="tw"><table><thead><tr><th>Refeição</th><th>Leito</th><th>Paciente</th><th>Alerta</th><th>Conflitos</th><th>Status</th><th className="no-print">Ações</th></tr></thead>
        <tbody>{(data?.items ?? []).map((o: any) => <tr key={o.id}>
          <td>{o.meal_type}</td><td>{o.patient.bed_id ? '●' : '—'}</td><td>{o.patient.name}<br /><small className="muted">{o.patient.consistency} • {o.patient.feeding_route}</small></td>
          <td>{o.allergy_alert ? <Badge v="critical" text={'ALERGIA ' + (o.allergies?.join(', ') ?? '')} /> : '—'}</td>
          <td>{o.conflicts.length ? o.conflicts.map((c: any, i: number) => <div key={i}><Badge v={c.level} /> {c.message}</div>) : <Badge v="ok" text="sem conflitos" />}</td>
          <td><Badge v={o.status} /></td>
          <td className="row no-print">
            {o.status === 'pending' && can('hospital.confer') && <button onClick={() => { const n = o.conflict_level === 'warning' ? prompt('Confirme os alertas (justificativa):') : undefined; if (o.conflict_level === 'warning' && !n) return; act(o.id, 'confer', { ack_note: n }) }} disabled={o.conflict_level === 'critical'}>Conferir</button>}
            {o.status === 'pending' && o.conflict_level === 'critical' && can('hospital.prescribe') && <select onChange={(e) => e.target.value && swap(o.id, e.target.value)} defaultValue=""><option value="">Substituir preparação…</option>{(recipes.data?.items ?? []).filter((r: any) => r.status === 'approved').map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
            {o.status === 'conferred' && can('hospital.release') && <button className="warn" onClick={() => act(o.id, 'release')}>Liberar</button>}
            {o.status === 'released' && can('hospital.produce') && <button onClick={() => act(o.id, 'produce')}>Produzido</button>}
            {o.status === 'produced' && can('hospital.deliver') && <button onClick={() => act(o.id, 'deliver')}>Entregue</button>}
            {o.label_code && <button className="sec" onClick={async () => setOpen(await get(`/meal-orders/${o.id}/label`))}>Etiqueta</button>}
          </td></tr>)}</tbody></table></div>
      {open && <div className="card" style={{ maxWidth: 360 }}><h2 style={{ marginTop: 0 }}>{open.label_code}</h2><p><b>{open.patient}</b> • leito {open.bed ?? '—'}<br />{open.meal_type} • {open.date}<br />{open.preparation}<br />{open.consistency} • {open.feeding_route}</p>
        {open.allergy_alert && <Badge v="critical" text={'ALERGIA: ' + open.allergies.join(', ')} />}<div className="row no-print" style={{ marginTop: 8 }}><button onClick={() => window.print()}>Imprimir</button><button className="sec" onClick={() => setOpen(null)}>Fechar</button></div></div>}
      <p className="muted no-print">Conflitos críticos (alergia, via de alimentação, regra de dieta, disfagia) não têm liberação por exceção: substitua a preparação.</p>
      <span hidden>{note}{setNote.length}</span>
    </Page>
  )
}

import { useState } from 'react'
import { downloadFile, get } from '../api'
import { Badge, Err, Page, UnitSelect, today, useLoad } from '../ui'

/** Mapas hospitalares do dia: distribuição por refeição/leito e produção por preparação. */
export function Maps() {
  const [unit, setUnit] = useState(''), [date, setDate] = useState(today()), [err, setErr] = useState<unknown>(null)
  const map = useLoad(() => (unit ? get(`/hospital/meal-map?unit_id=${unit}&date=${date}`) : Promise.resolve(null)), [unit, date])
  const prod = useLoad(() => (unit ? get(`/hospital/production-map?unit_id=${unit}&date=${date}`) : Promise.resolve(null)), [unit, date])
  return (
    <Page title="Mapas de refeições e produção" actions={<><button className="sec" disabled={!unit} onClick={() => downloadFile(`/meal-orders/export.pdf?unit_id=${unit}&date=${date}`, `mapa-${date}.pdf`).catch(setErr)}>Baixar PDF</button><button className="sec" onClick={() => window.print()}>Imprimir</button></>}>
      <Err e={err ?? map.error ?? prod.error} />
      <div className="row no-print"><div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} kinds={['hospital', 'clinic']} /></div><input type="date" style={{ width: 160 }} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <h2>Produção</h2><p className="muted">{prod.data?.note}</p>
      <div className="tw"><table><thead><tr><th>Refeição</th><th>Preparação</th><th>Porções</th><th>Liberadas</th></tr></thead><tbody>{(prod.data?.items ?? []).map((i: any, k: number) => <tr key={k}><td>{i.meal_type}</td><td>{i.recipe ?? <span className="muted">sem preparação definida</span>}</td><td>{i.portions}</td><td>{i.released}</td></tr>)}</tbody></table></div>
      <h2>Distribuição por leito</h2>
      {Object.entries(map.data?.meals ?? {}).map(([meal, rows]: [string, any]) => <div key={meal}><h3>{meal}</h3><div className="tw"><table><thead><tr><th>Leito</th><th>Paciente</th><th>Preparação</th><th>Consistência</th><th>Via</th><th>Alergias</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.order_id}><td>{r.bed}</td><td>{r.patient}</td><td>{r.preparation ?? '—'}</td><td>{r.consistency}</td><td>{r.feeding_route}</td><td>{r.allergy_alert ? <Badge v="critical" text={(r.allergies ?? ['sim']).join(', ')} /> : '—'}</td></tr>)}</tbody></table></div></div>)}
    </Page>
  )
}

import { useState } from 'react'
import { get, post } from '../api'
import { Badge, Err, Page, UnitSelect, fmt, today, useLoad } from '../ui'

const MEALS = ['cafe', 'colacao', 'almoco', 'lanche', 'jantar', 'ceia', 'brunch', 'buffet', 'room_service', 'evento']
const num = (s: string) => Number(s.replace(',', '.'))
/** Dimensionamento (parâmetros do usuário) e previsão de demanda por histórico real (recusa quando não há dados). */
export function Planning() {
  const [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null)
  const [d, setD] = useState({ portions_per_meal: '', service_minutes: '', preparation_hours: '', productivity_portions_per_worker_hour: '' }), [dim, setDim] = useState<any>(null)
  const [fc, setFc] = useState({ meal_type: 'almoco', date: today(), weeks: '8', margin_pct: '10' }), [fres, setFres] = useState<any>(null)
  const [hd, setHd] = useState({ meal_type: 'cafe', date: today(), take_up_pct: '' }), [hres, setHres] = useState<any>(null)
  const run = async (fn: () => Promise<any>, set: (v: any) => void) => { setErr(null); set(null); try { set(await fn()) } catch (x) { setErr(x) } }
  return (
    <Page title="Planejamento de produção e demanda" actions={<div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} /></div>}>
      <Err e={err} />
      <div className="card"><h2 style={{ marginTop: 0 }}>Dimensionamento de pessoal e equipamentos</h2>
        <div className="form">{([['portions_per_meal', 'Porções por refeição'], ['service_minutes', 'Duração do serviço (min)'], ['preparation_hours', 'Horas de preparo'], ['productivity_portions_per_worker_hour', 'Produtividade (porções/pessoa/h)']] as const).map(([k, l]) => <div className="field" key={k}><label>{l}</label><input inputMode="decimal" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} /></div>)}</div>
        <button disabled={!unit || Object.values(d).some((v) => !v)} onClick={() => run(() => post('/uan/dimensioning', { unit_id: unit, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, num(v)])) }), setDim)}>Calcular</button>
        {dim && <div style={{ marginTop: 10 }}><b>{dim.workers_needed}</b> pessoa(s) no preparo • <b>{fmt(dim.portions_per_hour_at_service, 1)}</b> porções/h no pico do serviço
          <div className="tw"><table><thead><tr><th>Equipamento</th><th>Capacidade (porções/h)</th><th>Atende o pico?</th><th>Unidades necessárias</th></tr></thead><tbody>{dim.equipment.map((e: any, i: number) => <tr key={i}><td>{e.name}</td><td>{e.capacity_portions_per_hour}</td><td><Badge v={e.covers_service_peak ? 'ok' : 'warning'} text={e.covers_service_peak ? 'sim' : 'não'} /></td><td>{e.units_needed}</td></tr>)}</tbody></table></div><p className="muted">{dim.note}</p></div>}</div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Previsão de refeições (UAN)</h2>
        <div className="row"><select value={fc.meal_type} onChange={(e) => setFc({ ...fc, meal_type: e.target.value })}>{MEALS.map((m) => <option key={m}>{m}</option>)}</select><input type="date" style={{ width: 160 }} value={fc.date} onChange={(e) => setFc({ ...fc, date: e.target.value })} />
          <input style={{ width: 90 }} title="Semanas de histórico" value={fc.weeks} onChange={(e) => setFc({ ...fc, weeks: e.target.value })} /><input style={{ width: 90 }} title="Margem de segurança %" value={fc.margin_pct} onChange={(e) => setFc({ ...fc, margin_pct: e.target.value })} />
          <button disabled={!unit} onClick={() => run(() => get(`/uan/demand-forecast?unit_id=${unit}&meal_type=${fc.meal_type}&date=${fc.date}&weeks=${fc.weeks}&margin_pct=${fc.margin_pct}`), setFres)}>Prever</button></div>
        {fres && (fres.sufficient ? <pre className="card" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(fres, null, 2)}</pre> : <div className="err">{fres.message}</div>)}{fres && <p className="muted">{fres.disclosure}</p>}</div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Demanda hoteleira por ocupação</h2>
        <div className="row"><select value={hd.meal_type} onChange={(e) => setHd({ ...hd, meal_type: e.target.value })}>{MEALS.map((m) => <option key={m}>{m}</option>)}</select><input type="date" style={{ width: 160 }} value={hd.date} onChange={(e) => setHd({ ...hd, date: e.target.value })} />
          <input style={{ width: 150 }} placeholder="Adesão % (opcional)" value={hd.take_up_pct} onChange={(e) => setHd({ ...hd, take_up_pct: e.target.value })} />
          <button disabled={!unit} onClick={() => run(() => get(`/hotel/demand?unit_id=${unit}&meal_type=${hd.meal_type}&date=${hd.date}${hd.take_up_pct ? `&take_up_pct=${hd.take_up_pct}` : ''}`), setHres)}>Calcular</button></div>
        {hres && (hres.sufficient ? <div style={{ marginTop: 8 }}>Hóspedes: <b>{hres.in_house_guests}</b> • adesão {hres.take_up_pct}% ({hres.take_up_source}) • porções hóspedes <b>{hres.in_house_portions}</b> + eventos {hres.event_guests} = <b>{hres.total_portions}</b></div> : <div className="err">{hres.message}</div>)}</div>
    </Page>
  )
}

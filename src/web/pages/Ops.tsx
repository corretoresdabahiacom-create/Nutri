import { useState } from 'react'
import { downloadFile, get, post } from '../api'
import { Badge, Err, Page, UnitSelect, fmt, money, today, useLoad, useMe } from '../ui'

export function Stock() {
  const { can } = useMe()
  const [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null), [f, setF] = useState({ food_id: '', qty_g: '', lot_code: '', expiry: '', unit_cost_per_kg: '' })
  const bal = useLoad(() => (unit ? get(`/stock/balance?unit_id=${unit}`) : Promise.resolve(null)), [unit])
  const foods = useLoad(() => get('/foods?limit=500'), [])
  const entry = async (e: React.FormEvent) => { e.preventDefault(); setErr(null); try { await post('/stock/entries', { unit_id: unit, food_id: f.food_id, qty_g: Number(f.qty_g), lot_code: f.lot_code, expiry: f.expiry || null, unit_cost_per_kg: Number(f.unit_cost_per_kg || 0) }); bal.reload() } catch (x) { setErr(x) } }
  return (
    <Page title="Estoque (FEFO)" actions={<><button className="sec" disabled={!unit} onClick={() => downloadFile(`/stock/balance/export.pdf?unit_id=${unit}`, 'estoque.pdf').catch(setErr)}>PDF</button><div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} /></div></>}>
      <Err e={err ?? bal.error} />
      {can('stock.write') && <form className="card form" onSubmit={entry}><div className="field"><label>Alimento</label><select value={f.food_id} onChange={(e) => setF({ ...f, food_id: e.target.value })} required><option value="">—</option>{(foods.data?.items ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        {(['qty_g', 'lot_code', 'unit_cost_per_kg'] as const).map((k) => <div className="field" key={k}><label>{({ qty_g: 'Quantidade (g)', lot_code: 'Lote', unit_cost_per_kg: 'Custo R$/kg' })[k]}</label><input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required={k !== 'unit_cost_per_kg'} /></div>)}
        <div className="field"><label>Validade</label><input type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} /></div><div className="field"><label>&nbsp;</label><button type="submit">Registrar entrada</button></div></form>}
      {can('stock.write') && <Transfer unit={unit} foods={foods.data?.items ?? []} onDone={bal.reload} setErr={setErr} />}
      <div className="tw"><table><thead><tr><th>Alimento</th><th>Disponível (g)</th><th>Vencido (g)</th><th>Vence ≤7d (g)</th><th>Mínimo</th><th>Valor</th></tr></thead>
        <tbody>{(bal.data?.items ?? []).map((i: any) => <tr key={i.food_id}><td>{i.name} {i.below_min && <Badge v="warning" text="abaixo do mínimo" />}</td><td>{fmt(i.available_g, 0)}</td><td>{i.expired_g > 0 ? <Badge v="critical" text={fmt(i.expired_g, 0)} /> : 0}</td><td>{fmt(i.expiring_g, 0)}</td><td>{fmt(i.min_g, 0)}</td><td>{money(i.value)}</td></tr>)}</tbody></table></div>
    </Page>
  )
}

function Transfer({ unit, foods, onDone, setErr }: { unit: string; foods: any[]; onDone: () => void; setErr: (e: unknown) => void }) {
  const [t, setT] = useState({ to: '', food_id: '', qty: '' }), [ok, setOk] = useState('')
  const go = async () => { setErr(null); setOk(''); try { await post('/stock/transfers', { from_unit_id: unit, to_unit_id: t.to, food_id: t.food_id, qty_g: Number(t.qty) }); setOk('Transferência registrada (FEFO, lotes preservados).'); onDone() } catch (x) { setErr(x) } }
  return <details className="card"><summary>Transferir entre unidades</summary><div className="row" style={{ marginTop: 8 }}>
    <div style={{ minWidth: 200 }}><UnitSelect value={t.to} onChange={(v) => setT({ ...t, to: v })} allowEmpty /></div>
    <select value={t.food_id} onChange={(e) => setT({ ...t, food_id: e.target.value })}><option value="">Alimento…</option>{foods.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
    <input style={{ width: 120 }} type="number" placeholder="Qtd (g)" value={t.qty} onChange={(e) => setT({ ...t, qty: e.target.value })} /><button disabled={!t.to || !t.food_id || !t.qty || t.to === unit} onClick={go}>Transferir da unidade selecionada</button></div>{ok && <div className="okmsg">{ok}</div>}</details>
}

export function Production() {
  const { can } = useMe()
  const [unit, setUnit] = useState(''), [date, setDate] = useState(today()), [err, setErr] = useState<unknown>(null), [f, setF] = useState({ recipe_id: '', meal_type: 'almoco', planned_portions: '' })
  const list = useLoad(() => (unit ? get(`/production-orders?unit_id=${unit}`) : Promise.resolve({ items: [] })), [unit])
  const recipes = useLoad(() => get('/recipes?current=1'), [])
  const act = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); list.reload() } catch (x) { setErr(x) } }
  return (
    <Page title="Ordens de produção" actions={<div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} /></div>}>
      <Err e={err ?? list.error} />
      {can('production.write') && <div className="card row"><input type="date" style={{ width: 160 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <select style={{ width: 240 }} value={f.recipe_id} onChange={(e) => setF({ ...f, recipe_id: e.target.value })}><option value="">Receita aprovada</option>{(recipes.data?.items ?? []).filter((r: any) => r.status === 'approved').map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <select style={{ width: 120 }} value={f.meal_type} onChange={(e) => setF({ ...f, meal_type: e.target.value })}>{['cafe', 'almoco', 'lanche', 'jantar', 'ceia'].map((m) => <option key={m}>{m}</option>)}</select>
        <input style={{ width: 120 }} type="number" placeholder="Porções" value={f.planned_portions} onChange={(e) => setF({ ...f, planned_portions: e.target.value })} />
        <button disabled={!f.recipe_id || !f.planned_portions} onClick={() => act(() => post('/production-orders', { unit_id: unit, date, ...f, planned_portions: Number(f.planned_portions) }))}>Planejar</button></div>}
      <div className="tw"><table><thead><tr><th>Data</th><th>Refeição</th><th>Porções</th><th>Status</th><th>Custo plan./real</th><th>Faltas de estoque</th><th></th></tr></thead>
        <tbody>{(list.data?.items ?? []).map((o: any) => <tr key={o.id}><td>{o.date}</td><td>{o.meal_type}</td><td>{o.planned_portions}{o.produced_portions != null && ` → ${o.produced_portions}`}</td><td><Badge v={o.status} /></td><td>{money(o.planned_cost)} / {money(o.actual_cost)}</td>
          <td>{o.stock_shortfalls.length ? o.stock_shortfalls.map((s: any) => <div key={s.food_id}><Badge v="warning" text={`${s.name}: faltam ${fmt(s.needed_g - s.available_g, 0)} g`} /></div>) : '—'}</td>
          <td className="row"><button className="sec" onClick={() => downloadFile(`/production-orders/${o.id}/export.pdf`, 'ordem-producao.pdf').catch(setErr)}>PDF</button>{o.status === 'planned' && can('production.write') && <><button onClick={() => act(() => post(`/production-orders/${o.id}/start`))}>Iniciar (baixa FEFO)</button><button className="sec" onClick={() => act(() => post(`/production-orders/${o.id}/cancel`))}>Cancelar</button></>}
            {o.status === 'in_progress' && can('production.write') && <button onClick={() => { const p = Number(prompt('Porções produzidas:')); if (p > 0) act(() => post(`/production-orders/${o.id}/complete`, { produced_portions: p, leftovers_g: Number(prompt('Sobras (g):', '0') || 0), waste_g: Number(prompt('Desperdício (g):', '0') || 0) })) }}>Concluir</button>}</td></tr>)}</tbody></table></div>
    </Page>
  )
}

export function Quality() {
  const { can } = useMe()
  const [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null), [t, setT] = useState({ equipment: '', reading_c: '', limit_min_c: '', limit_max_c: '' })
  const ncs = useLoad(() => get('/nonconformities'), [])
  const logs = useLoad(() => get('/temperature-logs'), [])
  const log = async (e: React.FormEvent) => { e.preventDefault(); setErr(null); try { const r = await post('/temperature-logs', { unit_id: unit, equipment: t.equipment, reading_c: Number(t.reading_c), limit_min_c: t.limit_min_c === '' ? undefined : Number(t.limit_min_c), limit_max_c: t.limit_max_c === '' ? undefined : Number(t.limit_max_c) }); if (!r.ok) setErr({ message: 'Temperatura fora do limite: não conformidade aberta automaticamente.' }); ncs.reload(); logs.reload() } catch (x) { setErr(x) } }
  const addAction = async (id: string) => { const d = prompt('Ação corretiva:'); if (!d) return; setErr(null); try { await post('/corrective-actions', { nonconformity_id: id, description: d }); ncs.reload() } catch (x) { setErr(x) } }
  const setStatus = async (id: string, status: string) => { setErr(null); try { await post(`/nonconformities/${id}/status`, { status }); ncs.reload() } catch (x) { setErr(x) } }
  return (
    <Page title="Qualidade e segurança alimentar" actions={<div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} /></div>}>
      <Err e={err ?? ncs.error} />
      {can('quality.write') && <form className="card form" onSubmit={log}><h2 style={{ gridColumn: '1/-1', margin: 0 }}>Registrar temperatura</h2>
        {(['equipment', 'reading_c', 'limit_min_c', 'limit_max_c'] as const).map((k) => <div className="field" key={k}><label>{({ equipment: 'Equipamento', reading_c: 'Leitura °C', limit_min_c: 'Limite mín. °C', limit_max_c: 'Limite máx. °C' })[k]}</label><input value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} required={k === 'equipment' || k === 'reading_c'} /></div>)}
        <div className="field"><label>&nbsp;</label><button type="submit">Registrar</button></div></form>}
      <h2>Não conformidades</h2>
      <div className="tw"><table><thead><tr><th>Título</th><th>Gravidade</th><th>Origem</th><th>Status</th><th></th></tr></thead><tbody>{(ncs.data?.items ?? []).map((n: any) => <tr key={n.id}><td>{n.title}</td><td><Badge v={n.severity === 'minor' ? 'ok' : n.severity === 'major' ? 'warning' : 'critical'} text={n.severity} /></td><td>{n.source}</td><td><Badge v={n.status === 'closed' ? 'ok' : 'warning'} text={n.status} /></td>
        <td className="row">{can('quality.write') && n.status !== 'closed' && <><button className="sec" onClick={() => addAction(n.id)}>+ Ação corretiva</button><button onClick={() => setStatus(n.id, 'closed')}>Encerrar</button></>}</td></tr>)}</tbody></table></div>
      <h2>Últimas temperaturas</h2>
      <div className="tw"><table><thead><tr><th>Quando</th><th>Equipamento</th><th>°C</th><th>OK</th></tr></thead><tbody>{(logs.data?.items ?? []).slice(0, 15).map((l: any) => <tr key={l.id}><td>{String(l.recorded_at).slice(0, 16).replace('T', ' ')}</td><td>{l.equipment}</td><td>{l.reading_c}</td><td><Badge v={l.ok ? 'ok' : 'critical'} text={l.ok ? 'ok' : 'fora'} /></td></tr>)}</tbody></table></div>
    </Page>
  )
}

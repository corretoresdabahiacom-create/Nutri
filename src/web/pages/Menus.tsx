import { useState } from 'react'
import { downloadCsv, get, post, put } from '../api'
import { Badge, Err, Page, UnitSelect, money, useLoad, useMe } from '../ui'

const MEALS = ['cafe', 'colacao', 'almoco', 'lanche', 'jantar', 'ceia']
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10)

export function Menus() {
  const { can } = useMe()
  const list = useLoad(() => get('/menus'), [])
  const [sel, setSel] = useState<string | null>(null), [name, setName] = useState(''), [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null)
  const create = async () => { try { const m = await post('/menus', { name, unit_id: unit || undefined, items: [] }); setName(''); list.reload(); setSel(m.id) } catch (x) { setErr(x) } }
  return (
    <Page title="Cardápios">
      <Err e={list.error ?? err} />
      {can('menus.write') && <div className="card row no-print"><input style={{ maxWidth: 260 }} placeholder="Nome do novo cardápio" value={name} onChange={(e) => setName(e.target.value)} /><div style={{ minWidth: 200 }}><UnitSelect value={unit} onChange={setUnit} /></div><button disabled={!name} onClick={create}>Criar</button></div>}
      {sel && <MenuEditor id={sel} onChange={list.reload} />}
      <div className="tw"><table><thead><tr><th>Nome</th><th>Versão</th><th>Status</th><th></th></tr></thead><tbody>{(list.data?.items ?? []).map((m: any) => <tr key={m.id}><td>{m.name}</td><td>v{m.version}</td><td><Badge v={m.status} /></td><td><button className="sec" onClick={() => setSel(m.id)}>Abrir</button></td></tr>)}</tbody></table></div>
    </Page>
  )
}

function MenuEditor({ id, onChange }: { id: string; onChange: () => void }) {
  const { can } = useMe()
  const { data, error, reload } = useLoad(() => get(`/menus/${id}`), [id])
  const recipes = useLoad(() => get('/recipes?current=1'), [])
  const [err, setErr] = useState<unknown>(null), [start, setStart] = useState(new Date().toISOString().slice(0, 10)), [over, setOver] = useState(''), [info, setInfo] = useState('')
  if (!data) return <Err e={error} />
  const draft = data.status === 'draft'
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  const act = async (fn: () => Promise<any>) => { setErr(null); setInfo(''); try { const r = await fn(); if (r?.public_path) setInfo('Link público (exibido uma vez): ' + location.origin + r.public_path); reload(); onChange() } catch (x) { setErr(x) } }
  const saveItems = (items: any[]) => act(() => put(`/menus/${id}`, { items: items.map((i) => ({ recipe_id: i.recipe_id, date: i.date, meal_type: i.meal_type, planned_portions: i.planned_portions, position: i.position })) }))
  const drop = (e: React.DragEvent, date: string, meal: string) => {
    e.preventDefault(); setOver('')
    const raw = e.dataTransfer.getData('text/plain'); if (!raw || !draft) return
    const d = JSON.parse(raw)
    if (d.item_id) act(() => post(`/menus/${id}/move-item`, { item_id: d.item_id, date, meal_type: meal, position: 99 }))
    else saveItems([...data.items, { recipe_id: d.recipe_id, date, meal_type: meal, planned_portions: 10, position: 99 }])
  }
  return (
    <div className="card">
      <div className="top"><h2 style={{ margin: 0 }}>{data.name} <Badge v={data.status} text={`${data.status} • v${data.version}`} /></h2>
        <div className="row no-print">
          <button className="sec" onClick={() => window.print()}>Imprimir / PDF</button><button className="sec" onClick={() => downloadCsv(`/menus/${id}/export.csv`, 'cardapio.csv').catch(setErr)}>CSV</button>
          {can('menus.write') && <button className="sec" onClick={() => act(() => post(`/menus/${id}/duplicate`, { shift_days: 7 }))}>Duplicar (+7 dias)</button>}
          {can('menus.write') && !draft && <button className="sec" onClick={() => act(() => post(`/menus/${id}/revise`))}>Nova versão</button>}
          {can('menus.approve') && draft && <button onClick={() => act(() => post(`/menus/${id}/approve`))}>Aprovar</button>}
          {can('menus.publish') && data.status === 'approved' && <button className="warn" onClick={() => act(() => post(`/menus/${id}/publish`))}>Publicar</button>}
          {can('menus.publish') && ['published', 'scheduled'].includes(data.status) && <button className="sec" onClick={() => act(() => post(`/menus/${id}/unpublish`))}>Despublicar</button>}
        </div></div>
      <Err e={err ?? error} />{info && <div className="okmsg">{info}</div>}
      <p><b>Custo total estimado:</b> {money(data.total_cost)} {!data.cost_complete && <Badge v="warning" text="custo incompleto" />} {data.budget && <Badge v={data.budget.exceeds ? 'critical' : 'ok'} text={`orçamento ${data.budget.profile}: ${data.budget.exceeds ? 'excedido' : 'dentro'}`} />}</p>
      {data.issues?.length > 0 && <div className="err">{data.issues.map((i: any, k: number) => <div key={k}>{i.recipe}: {i.problems.join('; ')}</div>)}</div>}
      <div className="row no-print"><label>Início da semana <input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label></div>
      {draft && <div className="card no-print"><b>Receitas (arraste para a grade):</b><div className="row">{(recipes.data?.items ?? []).filter((r: any) => r.status === 'approved').map((r: any) => <div key={r.id} className="chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ recipe_id: r.id }))}>{r.name}</div>)}</div></div>}
      <div className="tw"><table><thead><tr><th>Refeição</th>{days.map((d) => <th key={d}>{new Date(d + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</th>)}</tr></thead>
        <tbody>{MEALS.map((meal) => <tr key={meal}><th>{meal}</th>{days.map((d) => { const key = d + meal; const items = data.items.filter((i: any) => i.date === d && i.meal_type === meal); return (
          <td key={key} className={'cell' + (over === key ? ' over' : '')} onDragOver={(e) => { if (draft) { e.preventDefault(); setOver(key) } }} onDragLeave={() => setOver('')} onDrop={(e) => drop(e, d, meal)}>
            {items.map((i: any) => <div key={i.id} className="chip" draggable={draft} onDragStart={(e) => e.dataTransfer.setData('text/plain', JSON.stringify({ item_id: i.id }))}>{i.recipe}{i.allergens.length > 0 && <small> ⚠ {i.allergens.join(', ')}</small>}
              {draft && <button className="bad no-print" style={{ padding: '0 6px', marginLeft: 6 }} onClick={() => saveItems(data.items.filter((x: any) => x.id !== i.id))} aria-label="Remover">×</button>}</div>)}
          </td>) })}</tr>)}</tbody></table></div>
    </div>
  )
}

import { useState } from 'react'
import { downloadFile, get, post } from '../api'
import { Badge, Err, Page, fmt, money, useLoad, useMe } from '../ui'

export function Recipes() {
  const { can } = useMe()
  const list = useLoad(() => get('/recipes'), [])
  const [sel, setSel] = useState<string | null>(null), [creating, setCreating] = useState(false)
  return (
    <Page title="Fichas técnicas" actions={can('recipes.write') && <button onClick={() => { setCreating(true); setSel(null) }}>Nova ficha</button>}>
      <Err e={list.error} />
      {creating && <RecipeForm onDone={(id) => { setCreating(false); list.reload(); setSel(id) }} />}
      {sel && <RecipeDetail id={sel} onChange={list.reload} />}
      <div className="tw"><table><thead><tr><th>Nome</th><th>Versão</th><th>Status</th><th>Porções</th><th></th></tr></thead>
        <tbody>{(list.data?.items ?? []).map((r: any) => <tr key={r.id}><td>{r.name}</td><td>v{r.version}</td><td><Badge v={r.status} /></td><td>{r.portions}</td><td><button className="sec" onClick={() => { setSel(r.id); setCreating(false) }}>Abrir</button></td></tr>)}</tbody></table></div>
    </Page>
  )
}
function RecipeForm({ onDone }: { onDone: (id: string) => void }) {
  const foods = useLoad(() => get('/foods?limit=500'), [])
  const [f, setF] = useState({ name: '', portions: 10, yield_g: 0 }), [items, setItems] = useState([{ food_id: '', net_g: 0, gross_g: 0 }]), [err, setErr] = useState<unknown>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    try { const r = await post('/recipes', { ...f, items: items.filter((i) => i.food_id).map((i) => ({ food_id: i.food_id, net_g: Number(i.net_g), gross_g: i.gross_g ? Number(i.gross_g) : undefined })) }); onDone(r.id) } catch (x) { setErr(x) }
  }
  return (
    <form className="card" onSubmit={submit}><h2 style={{ marginTop: 0 }}>Nova ficha técnica</h2><Err e={err} />
      <div className="form"><div className="field"><label>Nome *</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
        <div className="field"><label>Porções</label><input type="number" value={f.portions} onChange={(e) => setF({ ...f, portions: Number(e.target.value) })} /></div>
        <div className="field"><label>Rendimento (g)</label><input type="number" value={f.yield_g} onChange={(e) => setF({ ...f, yield_g: Number(e.target.value) })} /></div></div>
      <h2>Ingredientes</h2>
      {items.map((it, i) => <div className="form" key={i}>
        <div className="field"><label>Alimento</label><select value={it.food_id} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, food_id: e.target.value } : x)))}><option value="">—</option>{(foods.data?.items ?? []).map((fd: any) => <option key={fd.id} value={fd.id}>{fd.name}</option>)}</select></div>
        <div className="field"><label>Peso líquido (g)</label><input type="number" value={it.net_g} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, net_g: Number(e.target.value) } : x)))} /></div>
        <div className="field"><label>Peso bruto (g)</label><input type="number" value={it.gross_g} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, gross_g: Number(e.target.value) } : x)))} /></div></div>)}
      <div className="row"><button type="button" className="sec" onClick={() => setItems([...items, { food_id: '', net_g: 0, gross_g: 0 }])}>+ Ingrediente</button><button type="submit">Salvar rascunho</button></div>
    </form>
  )
}
function RecipeDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const { can } = useMe()
  const { data, error, reload } = useLoad(() => get(`/recipes/${id}`), [id])
  const [err, setErr] = useState<unknown>(null), [rev, setRev] = useState({ nutrition_reviewed: false, allergens_reviewed: false, accept_incomplete_nutrition: false })
  if (!data) return <Err e={error} />
  const c = data.calc
  const act = async (p: string, b?: unknown) => { setErr(null); try { await post(p, b); reload(); onChange() } catch (x) { setErr(x) } }
  return (
    <div className="card">
      <div className="top"><h2 style={{ margin: 0 }}>{data.name} <Badge v={data.status} text={`${data.status} • v${data.version}`} /></h2>
        <div className="row no-print"><button className="sec" onClick={() => downloadFile(`/recipes/${id}/export.pdf`, 'ficha-tecnica.pdf').catch(setErr)}>Baixar PDF</button><button className="sec" onClick={() => window.print()}>Imprimir</button><button className="sec" onClick={() => act(`/recipes/${id}/duplicate`)}>Duplicar</button></div></div>
      <Err e={err ?? error} />
      {c && <><div className="grid"><div className="kpi"><b>{money(c.cost_per_portion)}</b><span>Custo por porção {!c.cost_complete && '(INCOMPLETO)'}</span></div><div className="kpi"><b>{money(c.cost_per_kg)}</b><span>Custo por kg</span></div>
        <div className="kpi"><b>{fmt(c.nutrition_per_portion.energy_kcal, 0)} kcal</b><span>Por porção ({fmt(c.portion_g, 0)} g)</span></div><div className="kpi"><b>{fmt(c.loss_pct, 1)}%</b><span>Perda / rendimento {fmt(c.yield_g, 0)} g</span></div></div>
        <p className="muted">Proteína {fmt(c.nutrition_per_portion.protein_g, 1)} g • Carboidrato {fmt(c.nutrition_per_portion.carb_g, 1)} g • Gordura {fmt(c.nutrition_per_portion.fat_g, 1)} g • Sódio {fmt(c.nutrition_per_portion.sodium_mg, 0)} mg</p>
        {c.allergens.length > 0 && <p><b>Alérgenos:</b> {c.allergens.map((a: string) => <Badge key={a} v="warning" text={a} />)}</p>}
        {c.missing_prices.length > 0 && <div className="err">Sem preço cadastrado: {c.missing_prices.join(', ')}. O custo não foi estimado.</div>}
        {c.missing_nutrition.length > 0 && <div className="err">Sem dados nutricionais: {c.missing_nutrition.join(', ')}.</div>}
        <div className="tw"><table><thead><tr><th>Ingrediente</th><th>Líquido (g)</th><th>Bruto (g)</th><th>R$/kg</th><th>Custo</th></tr></thead><tbody>{c.items.map((i: any) => <tr key={i.id}><td>{i.food_name}</td><td>{fmt(i.net_g, 1)}</td><td>{fmt(i.gross_g, 1)}</td><td>{money(i.price_per_kg)}</td><td>{money(i.cost)}</td></tr>)}</tbody></table></div></>}
      {data.status === 'draft' && can('recipes.approve') && <div className="card no-print" style={{ marginTop: 12 }}><h2 style={{ marginTop: 0 }}>Aprovar</h2>
        {(['nutrition_reviewed', 'allergens_reviewed', 'accept_incomplete_nutrition'] as const).map((k) => <label key={k}><input type="checkbox" style={{ width: 'auto' }} checked={rev[k]} onChange={(e) => setRev({ ...rev, [k]: e.target.checked })} /> {({ nutrition_reviewed: 'Revisei a composição nutricional', allergens_reviewed: 'Revisei os alérgenos', accept_incomplete_nutrition: 'Aceito composição incompleta (se houver)' })[k]}</label>)}
        <button onClick={() => act(`/recipes/${id}/approve`, rev)}>Aprovar versão</button></div>}
    </div>
  )
}

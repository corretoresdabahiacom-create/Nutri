import { useState } from 'react'
import { get, post } from '../api'
import { Badge, Err, Page, UnitSelect, fmt, money, today, useLoad, useMe } from '../ui'

export function Purchasing() {
  const { can } = useMe()
  const [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null), [msg, setMsg] = useState('')
  const [from, setFrom] = useState(today()), [to, setTo] = useState(today()), [sug, setSug] = useState<any[] | null>(null), [pick, setPick] = useState<Record<string, boolean>>({})
  const reqs = useLoad(() => get('/purchase-requests'), [])
  const orders = useLoad(() => get('/purchase-orders'), [])
  const suppliers = useLoad(() => get('/suppliers'), [])
  const foods = useLoad(() => get('/foods?limit=500'), [])
  const fname = (id: string) => (foods.data?.items ?? []).find((f: any) => f.id === id)?.name ?? id.slice(0, 8)
  const run = async (fn: () => Promise<any>, ok = '') => { setErr(null); setMsg(''); try { await fn(); setMsg(ok); reqs.reload(); orders.reload() } catch (x) { setErr(x) } }
  const suggest = () => run(async () => { const r = await post('/purchase-requests/suggest', { unit_id: unit, from, to }); setSug(r.suggestions); setPick(Object.fromEntries(r.suggestions.map((s: any) => [s.food_id, true]))) })
  const createReq = () => run(() => post('/purchase-requests', { unit_id: unit, items: sug!.filter((s) => pick[s.food_id]).map((s) => ({ food_id: s.food_id, qty_g: s.suggested_qty_g })) }), 'Requisição criada.')
  return (
    <Page title="Compras" actions={<div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} /></div>}>
      <Err e={err ?? reqs.error} />{msg && <div className="okmsg">{msg}</div>}
      {can('purchase.write') && <div className="card"><h2 style={{ marginTop: 0 }}>Sugestão a partir das ordens de produção planejadas</h2>
        <div className="row"><input type="date" style={{ width: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" style={{ width: 160 }} value={to} onChange={(e) => setTo(e.target.value)} /><button disabled={!unit} onClick={suggest}>Calcular necessidade</button></div>
        {sug && (sug.length ? <><div className="tw" style={{ marginTop: 8 }}><table><thead><tr><th></th><th>Alimento</th><th>Necessário (g)</th><th>Em estoque (g)</th><th>Comprar (g)</th><th>Estimativa</th></tr></thead>
          <tbody>{sug.map((s) => <tr key={s.food_id}><td><input type="checkbox" style={{ width: 'auto' }} checked={!!pick[s.food_id]} onChange={(e) => setPick({ ...pick, [s.food_id]: e.target.checked })} /></td><td>{s.name}</td><td>{fmt(s.needed_g, 0)}</td><td>{fmt(s.in_stock_g, 0)}</td><td>{fmt(s.suggested_qty_g, 0)}</td><td>{s.estimated_cost == null ? <Badge v="warning" text="sem preço" /> : money(s.estimated_cost)}</td></tr>)}</tbody></table></div>
          <button style={{ marginTop: 8 }} onClick={createReq}>Criar requisição com os itens marcados</button></> : <p className="muted">Nenhuma compra necessária para o período.</p>)}</div>}
      <h2>Requisições</h2>
      <div className="tw"><table><thead><tr><th>Criada</th><th>Itens</th><th>Status</th><th></th></tr></thead><tbody>{(reqs.data?.items ?? []).map((r: any) => <tr key={r.id}><td>{String(r.created_at).slice(0, 10)}</td><td>{r.items.map((i: any) => `${fname(i.food_id)} ${fmt(i.qty_g, 0)} g`).join('; ')}</td><td><Badge v={r.status === 'approved' ? 'ok' : 'warning'} text={r.status} /></td>
        <td className="row">{r.status === 'pending' && can('purchase.approve') && <button onClick={() => run(async () => { try { await post(`/purchase-requests/${r.id}/approve`) } catch (x: any) { if (x.code === 'self_approval' && confirm('Você criou esta requisição. Aprovar mesmo assim (sem segregação de funções)?')) await post(`/purchase-requests/${r.id}/approve`, { allow_self: true }); else throw x } }, 'Aprovada.')}>Aprovar</button>}
          {r.status === 'approved' && can('purchase.write') && <NewOrder req={r} suppliers={suppliers.data?.items ?? []} fname={fname} onDone={() => { reqs.reload(); orders.reload() }} setErr={setErr} />}</td></tr>)}</tbody></table></div>
      <h2>Pedidos de compra</h2>
      <div className="tw"><table><thead><tr><th>Criado</th><th>Status</th><th></th></tr></thead><tbody>{(orders.data?.items ?? []).map((o: any) => <OrderRow key={o.id} o={o} fname={fname} can={can('stock.write')} onDone={orders.reload} setErr={setErr} />)}</tbody></table></div>
    </Page>
  )
}
function NewOrder({ req, suppliers, fname, onDone, setErr }: any) {
  const [open, setOpen] = useState(false), [sup, setSup] = useState(''), [prices, setPrices] = useState<Record<string, string>>({})
  if (!open) return <button className="sec" onClick={() => setOpen(true)}>Gerar pedido</button>
  const save = async () => { setErr(null); try { await post('/purchase-orders', { unit_id: req.unit_id, supplier_id: sup, request_id: req.id, items: req.items.map((i: any) => ({ food_id: i.food_id, qty_g: i.qty_g, price_per_kg: Number(prices[i.food_id] ?? 0) })) }); setOpen(false); onDone() } catch (x) { setErr(x) } }
  return <div className="card" style={{ minWidth: 300 }}><select value={sup} onChange={(e) => setSup(e.target.value)}><option value="">Fornecedor…</option>{suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
    {req.items.map((i: any) => <div className="field" key={i.food_id}><label>{fname(i.food_id)} — R$/kg pago</label><input type="number" step="any" value={prices[i.food_id] ?? ''} onChange={(e) => setPrices({ ...prices, [i.food_id]: e.target.value })} /></div>)}
    <div className="row"><button disabled={!sup} onClick={save}>Criar pedido</button><button className="sec" onClick={() => setOpen(false)}>Cancelar</button></div></div>
}
function OrderRow({ o, fname, can, onDone, setErr }: any) {
  const [open, setOpen] = useState(false), [det, setDet] = useState<any>(null), [rec, setRec] = useState<Record<string, any>>({})
  const load = async () => { setDet(await get(`/purchase-orders/${o.id}`)); setOpen(true) }
  const receive = async () => { setErr(null); try { await post(`/purchase-orders/${o.id}/receive`, { items: det.items.filter((i: any) => rec[i.id]?.qty).map((i: any) => ({ item_id: i.id, received_qty_g: Number(rec[i.id].qty), lot_code: rec[i.id].lot, expiry: rec[i.id].expiry || undefined })) }); setOpen(false); onDone() } catch (x) { setErr(x) } }
  return <><tr><td>{String(o.created_at).slice(0, 10)}</td><td><Badge v={o.status === 'received' ? 'ok' : 'warning'} text={o.status} /></td><td>{['open', 'partial'].includes(o.status) && can && <button className="sec" onClick={load}>Receber</button>}</td></tr>
    {open && det && <tr><td colSpan={3}>{det.items.map((i: any) => <div className="row" key={i.id} style={{ marginBottom: 6 }}><span style={{ minWidth: 200 }}>{fname(i.food_id)} ({i.received_qty_g ?? 0}/{i.qty_g} g)</span>
      <input style={{ width: 110 }} type="number" placeholder="Qtd (g)" onChange={(e) => setRec({ ...rec, [i.id]: { ...rec[i.id], qty: e.target.value } })} /><input style={{ width: 120 }} placeholder="Lote" onChange={(e) => setRec({ ...rec, [i.id]: { ...rec[i.id], lot: e.target.value } })} /><input style={{ width: 150 }} type="date" onChange={(e) => setRec({ ...rec, [i.id]: { ...rec[i.id], expiry: e.target.value } })} /></div>)}
      <div className="row"><button onClick={receive}>Confirmar recebimento</button><button className="sec" onClick={() => setOpen(false)}>Fechar</button></div><p className="muted">O preço pago vira preço rastreável (fonte: pedido de compra).</p></td></tr>}</>
}

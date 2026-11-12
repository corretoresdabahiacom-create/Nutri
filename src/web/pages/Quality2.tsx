import { useState } from 'react'
import { del, get, post } from '../api'
import { Badge, Err, Page, UnitSelect, today, useLoad, useMe } from '../ui'

/** Modelos de checklist (criação) e execução com cálculo de nota. */
export function Checklists() {
  const { can } = useMe()
  const [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null), [res, setRes] = useState<any>(null)
  const tpls = useLoad(() => get('/checklist-templates'), [])
  const runs = useLoad(() => get('/checklist-runs'), [])
  const [nt, setNt] = useState({ name: '', kind: 'boas_praticas', lines: '' })
  const [sel, setSel] = useState(''), [ans, setAns] = useState<Record<string, boolean>>({}), [notes, setNotes] = useState<Record<string, string>>({})
  const tpl = (tpls.data?.items ?? []).find((t: any) => t.id === sel)
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    const items = nt.lines.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => ({ id: 'i' + (i + 1), text: l.replace(/^!\s*/, ''), critical: l.startsWith('!') }))
    try { await post('/checklist-templates', { name: nt.name, kind: nt.kind, items }); setNt({ name: '', kind: 'boas_praticas', lines: '' }); tpls.reload() } catch (x) { setErr(x) }
  }
  const run = async () => {
    setErr(null); setRes(null)
    try { setRes(await post('/checklist-runs', { unit_id: unit, template_id: sel, date: today(), answers: tpl.items.map((i: any) => ({ item_id: i.id, ok: !!ans[i.id], note: notes[i.id] || undefined })) })); runs.reload() } catch (x) { setErr(x) }
  }
  return (
    <Page title="Checklists de boas práticas" actions={<div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} /></div>}>
      <Err e={err ?? tpls.error} />
      {can('quality.write') && <form className="card" onSubmit={create}><h2 style={{ marginTop: 0 }}>Novo modelo</h2>
        <div className="form"><div className="field"><label>Nome *</label><input value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} required /></div>
          <div className="field"><label>Tipo</label><select value={nt.kind} onChange={(e) => setNt({ ...nt, kind: e.target.value })}>{['boas_praticas', 'recebimento', 'higienizacao', 'temperatura', 'outro'].map((k) => <option key={k}>{k}</option>)}</select></div></div>
        <div className="field"><label>Itens (um por linha; comece com ! para item crítico)</label><textarea rows={5} value={nt.lines} onChange={(e) => setNt({ ...nt, lines: e.target.value })} required /></div>
        <button type="submit">Salvar modelo</button></form>}
      {can('quality.write') && <div className="card"><h2 style={{ marginTop: 0 }}>Executar checklist</h2>
        <div className="field" style={{ maxWidth: 360 }}><select value={sel} onChange={(e) => { setSel(e.target.value); setAns({}); setRes(null) }}><option value="">Selecione o modelo…</option>{(tpls.data?.items ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        {tpl && <>{tpl.items.map((i: any) => <div key={i.id} className="row" style={{ marginBottom: 6 }}><label style={{ margin: 0, color: 'inherit' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!ans[i.id]} onChange={(e) => setAns({ ...ans, [i.id]: e.target.checked })} /> {i.text} {i.critical && <Badge v="critical" text="crítico" />}</label>
          <input style={{ maxWidth: 260 }} placeholder="Observação" value={notes[i.id] ?? ''} onChange={(e) => setNotes({ ...notes, [i.id]: e.target.value })} /></div>)}
          <button disabled={!unit} onClick={run}>Registrar execução</button></>}
        {res && <div className={res.failed.length ? 'err' : 'okmsg'} style={{ marginTop: 10 }}>Nota: <b>{res.score}%</b>{res.nonconformity_id && ' — não conformidade aberta automaticamente.'}</div>}</div>}
      <h2>Execuções recentes</h2>
      <div className="tw"><table><thead><tr><th>Data</th><th>Nota</th><th>Status</th></tr></thead><tbody>{(runs.data?.items ?? []).map((r: any) => <tr key={r.id}><td>{r.date}</td><td>{r.score}%</td><td><Badge v={r.status === 'done' ? 'ok' : 'warning'} text={r.status} /></td></tr>)}</tbody></table></div>
      {can('quality.write') && <><h2>Modelos</h2><div className="tw"><table><tbody>{(tpls.data?.items ?? []).map((t: any) => <tr key={t.id}><td>{t.name}</td><td>{t.items.length} itens</td><td><button className="bad" onClick={async () => { if (confirm('Excluir modelo?')) { try { await del(`/checklist-templates/${t.id}`); tpls.reload() } catch (x) { setErr(x) } } }}>Excluir</button></td></tr>)}</tbody></table></div></>}
    </Page>
  )
}

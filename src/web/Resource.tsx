import { useEffect, useState } from 'react'
import { del, downloadCsv, post, put } from './api'
import { Badge, Err, Page, UnitSelect, useLoad, useMe } from './ui'

export type FieldType = 'ref' | 'text' | 'number' | 'date' | 'datetime' | 'select' | 'bool' | 'unit' | 'list' | 'textarea'
export interface Field { name: string; label: string; type?: FieldType; options?: string[]; required?: boolean; hideInList?: boolean; refPath?: string }
export interface ResourceCfg {
  title: string; path: string; fields: Field[]; write: string; query?: string; exportCsv?: string; readOnlyFields?: string[]
  extraCols?: { label: string; render: (r: any) => React.ReactNode }[]; unitKinds?: string[]; hint?: string
}

function toForm(fields: Field[], row?: any) {
  const o: Record<string, any> = {}
  for (const f of fields) {
    const v = row?.[f.name]
    o[f.name] = f.type === 'list' ? (Array.isArray(v) ? v.join(', ') : '') : f.type === 'datetime' ? (v ? String(v).slice(0, 16) : '') : v ?? (f.type === 'bool' ? false : '')
  }
  return o
}
function toBody(fields: Field[], form: Record<string, any>) {
  const b: Record<string, any> = {}
  for (const f of fields) {
    const v = form[f.name]
    if (f.type === 'list') b[f.name] = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (f.type === 'number') b[f.name] = v === '' || v == null ? null : Number(v)
    else if (f.type === 'datetime') b[f.name] = v ? new Date(v).toISOString() : null
    else if (f.type === 'bool') b[f.name] = !!v
    else b[f.name] = v === '' ? null : v
  }
  return b
}

const refCache = new Map<string, Promise<any[]>>()
export function useRefItems(path: string) {
  const [items, setItems] = useState<any[]>([])
  useEffect(() => { let on = true; if (!refCache.has(path)) refCache.set(path, import('./api').then((a) => a.get(path)).then((r) => r.items ?? []).catch(() => { refCache.delete(path); return [] })); refCache.get(path)!.then((r) => on && setItems(r)); return () => { on = false } }, [path])
  return items
}
const refLabel = (x: any) => x.name ?? x.display_name ?? x.title ?? x.code ?? x.internal_code ?? x.email ?? String(x.id).slice(0, 8)
function RefSelect({ id, f, value, onChange }: { id: string; f: Field; value: any; onChange: (v: any) => void }) {
  const items = useRefItems(f.refPath!)
  return <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={f.required}><option value="">—</option>{items.map((x) => <option key={x.id} value={x.id}>{refLabel(x)}</option>)}</select>
}
function RefCell({ path, v }: { path: string; v: any }) { const items = useRefItems(path); const x = items.find((i) => i.id === v); return <>{v == null ? '—' : x ? refLabel(x) : String(v).slice(0, 8)}</> }

export function FieldInput({ f, value, onChange }: { f: Field; value: any; onChange: (v: any) => void }) {
  const id = 'f-' + f.name
  let input
  switch (f.type) {
    case 'select': input = <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>; break
    case 'bool': input = <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={{ width: 'auto' }} />; break
    case 'ref': input = <RefSelect id={id} f={f} value={value} onChange={onChange} />; break
    case 'unit': input = <UnitSelect value={value ?? ''} onChange={onChange} allowEmpty />; break
    case 'textarea': input = <textarea id={id} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />; break
    default: input = <input id={id} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text'} step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value)} required={f.required} />
  }
  return <div className="field"><label htmlFor={id}>{f.label}{f.required && ' *'}{f.type === 'list' && ' (separe por vírgula)'}</label>{input}</div>
}

export function ResourcePage({ cfg }: { cfg: ResourceCfg }) {
  const { can } = useMe()
  const canWrite = can(cfg.write)
  const { data, error, reload } = useLoad(() => import('./api').then((a) => a.get(cfg.path + (cfg.query ? '?' + cfg.query : ''))), [cfg.path, cfg.query])
  const [editing, setEditing] = useState<any | null>(null), [form, setForm] = useState<Record<string, any>>({}), [err, setErr] = useState<unknown>(null), [msg, setMsg] = useState('')
  const open = (row?: any) => { setEditing(row ?? {}); setForm(toForm(cfg.fields, row)); setErr(null); setMsg('') }
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    try {
      const body = toBody(cfg.fields.filter((f) => !cfg.readOnlyFields?.includes(f.name) || !editing.id), form)
      editing.id ? await put(`${cfg.path}/${editing.id}`, body) : await post(cfg.path, body)
      setEditing(null); setMsg('Salvo.'); reload()
    } catch (x) { setErr(x) }
  }
  const remove = async (row: any) => { if (!confirm('Excluir este registro?')) return; try { await del(`${cfg.path}/${row.id}`); reload() } catch (x) { setErr(x) } }
  const cols = cfg.fields.filter((f) => !f.hideInList)
  const show = (f: Field, v: any) => (f.type === 'bool' ? (v ? 'Sim' : 'Não') : Array.isArray(v) ? v.join(', ') : f.type === 'select' && (v === 'critical' || v === 'approved') ? <Badge v={v} /> : v == null ? '—' : String(v))
  return (
    <Page title={cfg.title} actions={<>{cfg.exportCsv && <button className="sec" onClick={() => downloadCsv(`/exports/${cfg.exportCsv}.csv`, cfg.exportCsv + '.csv').catch(setErr)}>Exportar CSV</button>}{canWrite && <button onClick={() => open()}>Novo</button>}</>}>
      {cfg.hint && <p className="muted">{cfg.hint}</p>}
      <Err e={error ?? err} />{msg && <div className="okmsg">{msg}</div>}
      {editing && (
        <form className="card" onSubmit={save}>
          <h2>{editing.id ? 'Editar' : 'Novo registro'}</h2>
          <div className="form">{cfg.fields.map((f) => <FieldInput key={f.name} f={f} value={form[f.name]} onChange={(v) => setForm({ ...form, [f.name]: v })} />)}</div>
          <div className="row"><button type="submit">Salvar</button><button type="button" className="sec" onClick={() => setEditing(null)}>Cancelar</button></div>
        </form>
      )}
      <div className="tw"><table><thead><tr>{cols.map((f) => <th key={f.name}>{f.label}</th>)}{cfg.extraCols?.map((c) => <th key={c.label}>{c.label}</th>)}{canWrite && <th></th>}</tr></thead>
        <tbody>{(data?.items ?? []).map((r: any) => <tr key={r.id}>{cols.map((f) => <td key={f.name}>{f.type === 'ref' ? <RefCell path={f.refPath!} v={r[f.name]} /> : show(f, r[f.name])}</td>)}{cfg.extraCols?.map((c) => <td key={c.label}>{c.render(r)}</td>)}
          {canWrite && <td className="row"><button className="sec" onClick={() => open(r)}>Editar</button><button className="bad" onClick={() => remove(r)}>Excluir</button></td>}</tr>)}
          {data && !data.items.length && <tr><td colSpan={cols.length + 2} className="muted">Nenhum registro.</td></tr>}</tbody></table></div>
    </Page>
  )
}

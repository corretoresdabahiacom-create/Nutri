import { useState } from 'react'
import { post } from '../api'
import { Err, Page, today } from '../ui'

const readFile = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsText(f) })

export function Imports() {
  const [err, setErr] = useState<unknown>(null), [res, setRes] = useState<any>(null)
  const [fd, setFd] = useState({ csv: '', source: '', table_version: '', license_confirmed: false })
  const [pr, setPr] = useState({ csv: '', source: '', valid_from: today() })
  const send = async (path: string, body: unknown) => { setErr(null); setRes(null); try { setRes(await post(path, body)) } catch (x) { setErr(x) } }
  return (
    <Page title="Importação CSV">
      <Err e={err} />{res && <div className="okmsg"><pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(res, null, 2)}</pre></div>}
      <div className="card"><h2 style={{ marginTop: 0 }}>Alimentos</h2>
        <p className="muted">Colunas: <code>name</code> (obrigatória), category, energy_kcal, protein_g, carb_g, fat_g, fiber_g, sodium_mg, allergens… Informe a fonte e a versão da tabela e confirme que tem direito de uso. Valores ausentes permanecem vazios.</p>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => e.target.files?.[0] && setFd({ ...fd, csv: await readFile(e.target.files[0]) })} />
        <textarea rows={4} placeholder="…ou cole o CSV aqui" value={fd.csv} onChange={(e) => setFd({ ...fd, csv: e.target.value })} style={{ marginTop: 8 }} />
        <div className="form" style={{ marginTop: 8 }}><div className="field"><label>Fonte *</label><input value={fd.source} onChange={(e) => setFd({ ...fd, source: e.target.value })} /></div><div className="field"><label>Versão da tabela *</label><input value={fd.table_version} onChange={(e) => setFd({ ...fd, table_version: e.target.value })} /></div></div>
        <label style={{ color: 'inherit' }}><input type="checkbox" style={{ width: 'auto' }} checked={fd.license_confirmed} onChange={(e) => setFd({ ...fd, license_confirmed: e.target.checked })} /> Confirmo que tenho direito de uso/licença destes dados</label>
        <div><button style={{ marginTop: 8 }} disabled={!fd.csv} onClick={() => send('/foods/import', fd)}>Importar alimentos</button></div></div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Preços</h2>
        <p className="muted">Colunas: <code>food_name</code>, <code>price_per_kg</code> (opcional: supplier). Nomes devem coincidir com alimentos cadastrados.</p>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => e.target.files?.[0] && setPr({ ...pr, csv: await readFile(e.target.files[0]) })} />
        <textarea rows={4} placeholder="…ou cole o CSV aqui" value={pr.csv} onChange={(e) => setPr({ ...pr, csv: e.target.value })} style={{ marginTop: 8 }} />
        <div className="form" style={{ marginTop: 8 }}><div className="field"><label>Fonte (cotação/NF) *</label><input value={pr.source} onChange={(e) => setPr({ ...pr, source: e.target.value })} /></div><div className="field"><label>Vigência desde *</label><input type="date" value={pr.valid_from} onChange={(e) => setPr({ ...pr, valid_from: e.target.value })} /></div></div>
        <button style={{ marginTop: 8 }} disabled={!pr.csv || !pr.source} onClick={() => send('/prices/import', pr)}>Importar preços</button></div>
    </Page>
  )
}

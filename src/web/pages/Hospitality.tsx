import { useState } from 'react'
import { get, post } from '../api'
import { Err, Page, UnitSelect, today, useLoad } from '../ui'

/** Hotel/resort: links para o hóspede registrar restrições (com consentimento) e resumo agregado para a cozinha. */
export function Hospitality() {
  const [unit, setUnit] = useState(''), [err, setErr] = useState<unknown>(null), [ref, setRef] = useState(''), [ttl, setTtl] = useState('72'), [link, setLink] = useState(''), [date, setDate] = useState(today())
  const sum = useLoad(() => (unit ? get(`/hotel/restrictions-summary?unit_id=${unit}&date=${date}`) : Promise.resolve(null)), [unit, date])
  const make = async () => { setErr(null); try { const r = await post('/guest-links', { unit_id: unit, guest_ref: ref, ttl_hours: Number(ttl) }); setLink(location.origin + r.path); setRef('') } catch (x) { setErr(x) } }
  const Tbl = ({ title, data }: { title: string; data: Record<string, number> }) => <div className="card"><h3 style={{ marginTop: 0 }}>{title}</h3>{Object.keys(data).length ? <table><tbody>{Object.entries(data).sort((a, b) => b[1] - a[1]).map(([k, n]) => <tr key={k}><td>{k}</td><td>{n}</td></tr>)}</tbody></table> : <span className="muted">nenhum registro</span>}</div>
  return (
    <Page title="Hóspedes — restrições alimentares" actions={<div style={{ minWidth: 220 }}><UnitSelect value={unit} onChange={setUnit} kinds={['hotel', 'resort', 'restaurant']} /></div>}>
      <Err e={err ?? sum.error} />
      <div className="card"><h2 style={{ marginTop: 0 }}>Link para o hóspede</h2><div className="row"><input placeholder="Referência (ex.: apto 204 / reserva)" value={ref} onChange={(e) => setRef(e.target.value)} /><input style={{ width: 110 }} title="Validade (horas)" value={ttl} onChange={(e) => setTtl(e.target.value)} /><button disabled={!unit || !ref} onClick={make}>Gerar link</button></div>
        {link && <div className="okmsg" style={{ marginTop: 8 }}>Entregue ao hóspede (exibido uma vez): <code style={{ wordBreak: 'break-all' }}>{link}</code></div>}
        <p className="muted">O hóspede informa voluntariamente alergias e preferências, com consentimento (LGPD). Sem consentimento, nada é gravado.</p></div>
      <div className="row"><label>Data <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label></div>
      {sum.data && <><p>Hóspedes com registro e consentimento na data: <b>{sum.data.guests_with_records}</b></p><div className="grid"><Tbl title="Alergias" data={sum.data.allergies} /><Tbl title="Intolerâncias" data={sum.data.intolerances} /><Tbl title="Culturais/religiosas" data={sum.data.cultural_religious} /></div><p className="muted">Resumo agregado, sem identificar hóspedes. Dados individuais ficam restritos a quem tem a permissão específica.</p></>}
    </Page>
  )
}

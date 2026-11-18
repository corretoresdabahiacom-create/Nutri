import { useState } from 'react'
import { del, downloadFile, get, post } from '../api'
import { Err, Page, fmt, useLoad, useMe } from '../ui'

const MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']
const toB64 = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = no; r.readAsDataURL(f) })

/** Documentos privados: upload, download auditado e envio por e-mail somente após confirmação explícita. */
export function Documents() {
  const { can } = useMe()
  const docs = useLoad(() => get('/documents'), [])
  const [err, setErr] = useState<unknown>(null), [msg, setMsg] = useState(''), [kind, setKind] = useState('file'), [mail, setMail] = useState<any>(null)
  const run = async (fn: () => Promise<any>, ok = '') => { setErr(null); setMsg(''); try { await fn(); setMsg(ok); docs.reload() } catch (x) { setErr(x) } }
  const upload = (file?: File) => file && run(async () => {
    if (!MIMES.includes(file.type)) throw new Error('Tipo não permitido: ' + (file.type || 'desconhecido') + '. Aceitos: ' + MIMES.join(', '))
    await post('/documents', { title: file.name, kind, mime: file.type, content_b64: await toB64(file) })
  }, 'Documento enviado.')
  return (
    <Page title="Documentos">
      <Err e={err ?? docs.error} />{msg && <div className="okmsg">{msg}</div>}
      {can('docs.write') && <div className="card row"><select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">{['file', 'laudo', 'procedimento', 'evidencia', 'contrato', 'outro'].map((k) => <option key={k}>{k}</option>)}</select>
        <input type="file" accept={MIMES.join(',')} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} /><span className="muted">Armazenamento privado; acesso e download ficam no log de auditoria.</span></div>}
      <div className="tw"><table><thead><tr><th>Título</th><th>Tipo</th><th>Tamanho</th><th>Enviado</th><th></th></tr></thead><tbody>{(docs.data?.items ?? []).map((d: any) => <tr key={d.id}><td>{d.title}</td><td>{d.kind}</td><td>{fmt(d.size / 1024, 0)} KB</td><td>{String(d.created_at).slice(0, 10)}</td>
        <td className="row"><button className="sec" onClick={() => downloadFile(`/documents/${d.id}/content`, d.title).catch(setErr)}>Baixar</button>
          {can('docs.write') && <button className="sec" onClick={() => setMail({ id: d.id, clinical: !!d.related_type && ['patients', 'athletes'].includes(d.related_type), to: '', legal_basis: '', confirm: false })}>Enviar por e-mail</button>}
          {can('docs.write') && <button className="bad" onClick={() => confirm('Excluir documento?') && run(() => del(`/documents/${d.id}`), 'Excluído.')}>Excluir</button>}</td></tr>)}</tbody></table></div>
      {mail && <div className="card"><h2 style={{ marginTop: 0 }}>Enviar por e-mail</h2>
        <div className="form"><div className="field"><label>Destinatário</label><input type="email" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} /></div>
          {mail.clinical && <div className="field"><label>Base legal / finalidade (LGPD) *</label><input value={mail.legal_basis} onChange={(e) => setMail({ ...mail, legal_basis: e.target.value })} /></div>}</div>
        <label style={{ color: 'inherit' }}><input type="checkbox" style={{ width: 'auto' }} checked={mail.confirm} onChange={(e) => setMail({ ...mail, confirm: e.target.checked })} /> Confirmo o envio deste documento ao destinatário</label>
        <div className="row" style={{ marginTop: 8 }}><button disabled={!mail.confirm || !mail.to} onClick={() => run(async () => { await post(`/documents/${mail.id}/send-email`, { to: mail.to, confirm: true, legal_basis: mail.legal_basis || undefined }); setMail(null) }, 'E-mail entregue ao provedor.')}>Enviar</button><button className="sec" onClick={() => setMail(null)}>Cancelar</button></div>
        <p className="muted">O envio só é registrado como concluído quando o provedor de e-mail confirma. Sem integração configurada, nada é enviado.</p></div>}
    </Page>
  )
}

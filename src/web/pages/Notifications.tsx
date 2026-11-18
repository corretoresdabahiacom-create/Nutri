import { get, post } from '../api'
import { Err, Page, useLoad } from '../ui'

export function Notifications() {
  const n = useLoad(() => get('/notifications'), [])
  const read = async (id: string) => { await post(`/notifications/${id}/read`, {}); n.reload() }
  return <Page title="Notificações"><Err e={n.error} />
    <div className="tw"><table><thead><tr><th>Quando</th><th>Aviso</th><th></th></tr></thead><tbody>{(n.data?.items ?? []).map((x: any) => <tr key={x.id} style={{ fontWeight: x.read_at ? 400 : 700 }}><td>{String(x.created_at).slice(0, 16).replace('T', ' ')}</td><td>{x.title}<br /><small className="muted">{x.body}</small></td><td>{!x.read_at && <button className="sec" onClick={() => read(x.id)}>Marcar como lida</button>}</td></tr>)}</tbody></table></div></Page>
}

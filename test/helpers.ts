import { SELF } from 'cloudflare:test'

export type J = Record<string, any>
export async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await SELF.fetch('http://localhost' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const ct = res.headers.get('content-type') ?? ''
  const data: any = ct.includes('json') ? await res.json() : await res.text()
  return { status: res.status, data, headers: res.headers }
}
export const get = (p: string, t?: string) => call('GET', p, t)
export const post = (p: string, t: string | undefined, b?: unknown) => call('POST', p, t, b ?? {})
export const put = (p: string, t: string | undefined, b?: unknown) => call('PUT', p, t, b ?? {})
export const del = (p: string, t?: string) => call('DELETE', p, t)

let counter = 0
export const PW = 'Senha-segura-123'
/** Cria uma organização isolada com administrador; devolve token e ids. */
export async function newOrg(plan = 'enterprise', name = 'Org') {
  counter++
  const email = `admin${counter}-${crypto.randomUUID().slice(0, 6)}@teste.dev`
  const r = await post('/api/auth/register', undefined, { email, password: PW, name: 'Admin ' + counter, organization_name: `${name} ${counter}`, plan_key: plan })
  if (r.status !== 201) throw new Error('register falhou: ' + JSON.stringify(r.data))
  return { token: r.data.token as string, orgId: r.data.organization_id as string, email, userId: r.data.user_id as string }
}
export async function roleId(token: string, key: string): Promise<string> {
  const r = await get('/api/roles', token)
  return r.data.items.find((x: J) => x.key === key).id
}
export async function unit(token: string, name: string, kind = 'generic', parent?: string) {
  const r = await post('/api/units', token, { name, kind, parent_unit_id: parent })
  if (r.status !== 201) throw new Error('unit: ' + JSON.stringify(r.data))
  return r.data.id as string
}
/** Cria usuário com papel/unidade e devolve token de login. */
export async function userWithRole(adminToken: string, roleKey: string, unitId?: string) {
  counter++
  const email = `u${counter}-${crypto.randomUUID().slice(0, 6)}@teste.dev`
  const rid = await roleId(adminToken, roleKey)
  const cr = await post('/api/users', adminToken, { email, name: roleKey, password: PW, role_id: rid, unit_id: unitId })
  if (cr.status !== 201) throw new Error('user: ' + JSON.stringify(cr.data))
  const lr = await post('/api/auth/login', undefined, { email, password: PW })
  if (lr.status !== 200) throw new Error('login: ' + JSON.stringify(lr.data))
  return { token: lr.data.token as string, userId: cr.data.user_id as string, email }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message) }
}
let token: string | null = null
try { token = sessionStorage.getItem('nv_token') } catch { /* armazenamento indisponível */ }
export const setToken = (t: string | null) => {
  token = t
  try { t ? sessionStorage.setItem('nv_token', t) : sessionStorage.removeItem('nv_token') } catch { /* ignore */ }
}
export const hasToken = () => !!token

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const ct = res.headers.get('content-type') ?? ''
  const data = ct.includes('json') ? await res.json() : await res.text()
  if (!res.ok) {
    if (res.status === 401 && (data as any)?.error?.code !== 'mfa_required' && path !== '/auth/login') { setToken(null); window.dispatchEvent(new Event('nv-logout')) }
    const e = (data as any)?.error ?? {}
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Erro ${res.status}`, e.details)
  }
  return data as T
}
export const get = <T = any>(p: string) => api<T>('GET', p)
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {})
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {})
export const del = <T = any>(p: string) => api<T>('DELETE', p)

export async function downloadCsv(path: string, filename: string) {
  const res = await fetch('/api' + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new ApiError(res.status, 'export_failed', 'Falha na exportação')
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
}

import type { Context } from 'hono'

export interface Env {
  DB: D1Database
  ASSETS?: Fetcher
  DATA_KEY: string
  DATA_KEY_PREVIOUS?: string
  PLATFORM_ADMIN_EMAIL?: string
  ENVIRONMENT?: string
  RL_REGISTER?: string
  RL_LOGIN_IP?: string
  FILES?: R2Bucket
  MAX_DOC_MB?: string
  // Credenciais de plataforma (opcionais). Cada organização também pode configurar as suas em /integrations/:kind.
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  WHATSAPP_TOKEN?: string
  WHATSAPP_PHONE_ID?: string
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code)
  }
}
export const bad = (code: string, message?: string, details?: unknown) => new HttpError(400, code, message, details)
export const forbidden = (message = 'Acesso negado') => new HttpError(403, 'forbidden', message)
export const notFound = (what = 'Recurso') => new HttpError(404, 'not_found', `${what} não encontrado`)
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details)

export const uid = () => crypto.randomUUID()
export const nowIso = () => new Date().toISOString()
export const today = () => new Date().toISOString().slice(0, 10)

export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
}

export const round = (n: number, d = 2) => {
  const f = 10 ** d
  return Math.round((n + Number.EPSILON) * f) / f
}
export const num = (v: unknown, def = 0) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : def
}

export function parseJson<T>(s: unknown, def: T): T {
  if (typeof s !== 'string' || s === '') return def
  try {
    return JSON.parse(s) as T
  } catch {
    return def
  }
}

/** Normaliza texto para comparação de alérgenos/restrições (sem acento, minúsculas). */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

export async function readBody(c: Context): Promise<Record<string, any>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw bad('invalid_json', 'Corpo da requisição deve ser JSON válido')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid_body', 'Corpo deve ser um objeto JSON')
  return body as Record<string, any>
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  // evita injeção de fórmulas em planilhas
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
export function toCsv(rows: Record<string, unknown>[], cols?: string[]): string {
  const headers = cols ?? (rows[0] ? Object.keys(rows[0]) : [])
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n')
}

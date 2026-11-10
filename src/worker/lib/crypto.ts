import type { Env } from './util'

const te = new TextEncoder()
const td = new TextDecoder()

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', te.encode(s)))
}
export function randomToken(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer)
}

const keyCache = new Map<string, CryptoKey>()
async function dataKey(secret: string): Promise<CryptoKey> {
  const hit = keyCache.get(secret)
  if (hit) return hit
  const raw = await crypto.subtle.digest('SHA-256', te.encode(secret))
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  keyCache.set(secret, k)
  return k
}

/**
 * Criptografia de campos sensíveis em repouso (AES-256-GCM).
 * `aad` (ex.: "patients.allergies.<id>") amarra o texto cifrado ao registro/campo,
 * impedindo copiar um valor cifrado para outra linha.
 * Formato: v1.<iv>.<ciphertext> — "v1" identifica a chave corrente para rotação.
 */
export async function encryptValue(env: Env, value: unknown, aad: string): Promise<string | null> {
  if (value === null || value === undefined) return null
  if (!env.DATA_KEY || env.DATA_KEY.length < 16) throw new Error('DATA_KEY ausente ou curta demais')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) },
    await dataKey(env.DATA_KEY),
    te.encode(JSON.stringify(value))
  )
  return `v1.${b64(iv)}.${b64(ct)}`
}

export async function decryptValue<T = unknown>(env: Env, stored: string | null | undefined, aad: string): Promise<T | null> {
  if (!stored) return null
  const [ver, ivS, ctS] = stored.split('.')
  if (ver !== 'v1' || !ivS || !ctS) throw new Error('Formato de dado cifrado inválido')
  const keys = [env.DATA_KEY, env.DATA_KEY_PREVIOUS].filter(Boolean) as string[]
  let lastErr: unknown
  for (const secret of keys) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(ivS), additionalData: te.encode(aad) },
        await dataKey(secret),
        unb64(ctS)
      )
      return JSON.parse(td.decode(pt)) as T
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error('Falha ao decifrar dado sensível: ' + String(lastErr))
}

// ---- senhas (PBKDF2-SHA256; 100.000 é o máximo aceito pelo runtime Workers) ----
export const PBKDF2_ITERATIONS = 100_000
export async function hashPassword(password: string, salt?: string, iterations = PBKDF2_ITERATIONS) {
  const saltBytes = salt ? unb64(salt) : crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256)
  return { hash: b64(bits), salt: b64(saltBytes), iterations }
}
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

// ---- TOTP (RFC 6238, SHA-1, 6 dígitos, passo 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
export function base32Decode(s: string): Uint8Array {
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('base32 inválido')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)))
}
export async function totpCode(secretB32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const buf = new ArrayBuffer(8)
  new DataView(buf).setBigUint64(0, BigInt(counter))
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf))
  const off = h[h.length - 1] & 0xf
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 1_000_000).padStart(6, '0')
}
export async function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false
  const step = Math.floor(nowMs / 30_000)
  for (const d of [-1, 0, 1]) if (timingSafeEqual(await totpCode(secretB32, step + d), code)) return true
  return false
}

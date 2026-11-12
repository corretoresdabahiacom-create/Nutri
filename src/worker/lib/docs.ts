import { b64, unb64 } from './crypto'
import { type Env } from './util'

/** Armazenamento de documentos: R2 quando o binding FILES existir; senão fragmentos em D1 (≤ ~700 KB cada). */
const CHUNK = 700_000
export const maxDocBytes = (env: Env) => Math.floor(Number(env.MAX_DOC_MB ?? (env.FILES ? 25 : 8)) * 1024 * 1024)

export async function putContent(env: Env, id: string, bytes: Uint8Array): Promise<{ storage: 'd1' | 'r2'; chunks: number; content_b64: string }> {
  if (env.FILES) {
    await env.FILES.put(`docs/${id}`, bytes)
    return { storage: 'r2', chunks: 0, content_b64: '' }
  }
  const s = b64(bytes)
  if (s.length <= CHUNK) return { storage: 'd1', chunks: 0, content_b64: s }
  const n = Math.ceil(s.length / CHUNK)
  const stmts = []
  for (let i = 0; i < n; i++) stmts.push(env.DB.prepare('INSERT INTO document_chunks (doc_id,idx,data_b64) VALUES (?,?,?)').bind(id, i, s.slice(i * CHUNK, (i + 1) * CHUNK)))
  for (let i = 0; i < stmts.length; i += 20) await env.DB.batch(stmts.slice(i, i + 20))
  return { storage: 'd1', chunks: n, content_b64: '' }
}

export async function getContent(env: Env, d: { id: string; storage: string; chunk_count: number; content_b64: string }): Promise<Uint8Array> {
  if (d.storage === 'r2') {
    const o = await env.FILES?.get(`docs/${d.id}`)
    if (!o) throw new Error('arquivo ausente no armazenamento')
    return new Uint8Array(await o.arrayBuffer())
  }
  if (!d.chunk_count) return unb64(d.content_b64)
  const rows = (await env.DB.prepare('SELECT data_b64 FROM document_chunks WHERE doc_id=? ORDER BY idx').bind(d.id).all<any>()).results
  return unb64(rows.map((r) => r.data_b64).join(''))
}

export async function removeContent(env: Env, d: { id: string; storage: string }): Promise<void> {
  if (d.storage === 'r2') await env.FILES?.delete(`docs/${d.id}`)
  await env.DB.prepare('DELETE FROM document_chunks WHERE doc_id=?').bind(d.id).run()
}

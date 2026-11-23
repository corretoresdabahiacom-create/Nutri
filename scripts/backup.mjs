#!/usr/bin/env node
/**
 * Backup criptografado do D1 e teste de restauração.
 *   node scripts/backup.mjs backup  <saida.sql.enc>  [--remote]   (exige BACKUP_KEY e, para --remote, credenciais Cloudflare)
 *   node scripts/backup.mjs restore <entrada.sql.enc> <dir-persist-destino>   (restaura em D1 LOCAL vazio)
 *   node scripts/backup.mjs verify  [--remote]  (backup -> restauração em D1 local limpo -> compara contagem de linhas por tabela)
 * Cifra: AES-256-GCM, chave derivada por scrypt de BACKUP_KEY (>= 16 caracteres). Formato: "NVBK1" | salt(16) | iv(12) | tag(16) | dados.
 */
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DB = 'nutrivida', MAGIC = Buffer.from('NVBK1')
const key = process.env.BACKUP_KEY
if (!key || key.length < 16) { console.error('Defina BACKUP_KEY com ao menos 16 caracteres.'); process.exit(2) }
const wr = (args, opts = {}) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30, ...opts })

export function encrypt(buf) {
  const salt = randomBytes(16), iv = randomBytes(12), c = createCipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv)
  const ct = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct])
}
export function decrypt(buf) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('Arquivo de backup inválido')
  const salt = buf.subarray(5, 21), iv = buf.subarray(21, 33), tag = buf.subarray(33, 49)
  const d = createDecipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv); d.setAuthTag(tag)
  return Buffer.concat([d.update(buf.subarray(49)), d.final()])
}
const q = (persist, sql) => JSON.parse(wr(['d1', 'execute', DB, '--local', '--persist-to', persist, '--json', '--command', sql]))[0].results
const lit = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
/** Dados (sem esquema: o esquema vem das migrações). Remoto usa o export nativo; local gera INSERTs. */
function exportSql(remote, persist) {
  if (remote) {
    const dir = mkdtempSync(join(tmpdir(), 'nvbk-')), f = join(dir, 'dump.sql')
    wr(['d1', 'export', DB, '--remote', '--no-schema', '--output', f])
    const sql = readFileSync(f); rmSync(dir, { recursive: true, force: true }); return sql
  }
  const out = []
  for (const { name } of q(persist, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY name"))
    for (const r of q(persist, `SELECT * FROM "${name}"`)) out.push(`INSERT INTO "${name}" (${Object.keys(r).map((k) => `"${k}"`).join(',')}) VALUES (${Object.values(r).map(lit).join(',')});`)
  return Buffer.from(out.join('\n') + '\n')
}
function counts(persist) {
  const out = wr(['d1', 'execute', DB, '--local', '--persist-to', persist, '--json', '--command', "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY name"])
  const names = JSON.parse(out)[0].results.map((r) => r.name), res = {}
  for (const n of names) res[n] = JSON.parse(wr(['d1', 'execute', DB, '--local', '--persist-to', persist, '--json', '--command', `SELECT COUNT(*) n FROM "${n}"`]))[0].results[0].n
  return res
}
function restore(file, persist) {
  wr(['d1', 'migrations', 'apply', DB, '--local', '--persist-to', persist])
  const sql = decrypt(readFileSync(file)), dir = mkdtempSync(join(tmpdir(), 'nvrs-')), f = join(dir, 'restore.sql')
  const wipe = q(persist, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations'").map((t) => `DELETE FROM "${t.name}";`).join('\n')
  writeFileSync(f, 'PRAGMA defer_foreign_keys = on;\n' + wipe + '\n' + sql); wr(['d1', 'execute', DB, '--local', '--persist-to', persist, '--file', f]); rmSync(dir, { recursive: true, force: true })
}

const [cmd, a, b] = process.argv.slice(2)
if (cmd === 'backup') { writeFileSync(a, encrypt(exportSql(process.argv.includes('--remote'), '.wrangler/state'))); console.log('Backup cifrado gravado em', a) }
else if (cmd === 'restore') { restore(a, b); console.log('Restaurado em', b) }
else if (cmd === 'verify') {
  const remote = process.argv.includes('--remote'), src = '.wrangler/backup-src', dst = '.wrangler/backup-restored'
  rmSync(dst, { recursive: true, force: true })
  const tmp = join(mkdtempSync(join(tmpdir(), 'nvv-')), 'b.enc'); writeFileSync(tmp, encrypt(exportSql(remote, remote ? undefined : src)))
  restore(tmp, dst)
  const before = remote ? null : counts(src), after = counts(dst)
  if (before) { const diff = Object.keys(before).filter((t) => before[t] !== after[t]); if (diff.length) { console.error('DIVERGÊNCIA em:', diff.map((t) => `${t}: ${before[t]} != ${after[t]}`).join('; ')); process.exit(1) } }
  console.log(`Restauração verificada: ${Object.keys(after).length} tabelas, ${Object.values(after).reduce((s, n) => s + n, 0)} linhas.`)
} else { console.error('Uso: backup <arq> [--remote] | restore <arq> <persist> | verify [--remote]'); process.exit(2) }

// Garante a existência do banco D1 "nutrivida" e grava o database_id no wrangler.jsonc (usado no CI).
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const sh = (c) => execSync(c, { encoding: 'utf8' })
let list = JSON.parse(sh('npx wrangler d1 list --json'))
let db = list.find((d) => d.name === 'nutrivida')
if (!db) { sh('npx wrangler d1 create nutrivida'); db = JSON.parse(sh('npx wrangler d1 list --json')).find((d) => d.name === 'nutrivida') }
const id = db.uuid ?? db.id
const cfg = readFileSync('wrangler.jsonc', 'utf8').replace(/"database_id":\s*"[^"]*"/, `"database_id": "${id}"`)
writeFileSync('wrangler.jsonc', cfg)
console.log('D1 pronto:', id)

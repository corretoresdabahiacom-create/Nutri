import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

/** Gerador de PDF no servidor (pdf-lib, sem dependências nativas). Fonte Helvetica (WinAnsi): acentos do português funcionam. */
export type Block =
  | { t: 'h'; text: string }
  | { t: 'p'; text: string }
  | { t: 'alert'; text: string }
  | { t: 'kv'; rows: [string, string][] }
  | { t: 'table'; head: string[]; rows: string[][]; widths?: number[] }
export interface PdfDoc { title: string; subtitle?: string; footer?: string; landscape?: boolean; blocks: Block[] }

const WIN_EXTRA: Record<string, string> = { '→': '->', '≤': '<=', '≥': '>=', '×': 'x', '∗': '*', '✓': 'OK', '✗': 'X', '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '-' }
/** Troca caracteres fora do WinAnsi por equivalentes seguros (evita exceção do codificador). */
export function safe(s: unknown): string {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => WIN_EXTRA[ch] ?? '?')
}
function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const w of safe(text).split(' ')) {
    const cand = line ? line + ' ' + w : w
    if (font.widthOfTextAtSize(cand, size) <= max) { line = cand; continue }
    if (line) out.push(line)
    let rest = w
    while (font.widthOfTextAtSize(rest, size) > max && rest.length > 1) {
      let n = rest.length - 1
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > max) n--
      out.push(rest.slice(0, n)); rest = rest.slice(n)
    }
    line = rest
  }
  if (line || !out.length) out.push(line)
  return out
}

export async function buildPdf(doc: PdfDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(safe(doc.title)); pdf.setProducer('NutriVida Pro'); pdf.setCreator('NutriVida Pro')
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const W = doc.landscape ? 841.89 : 595.28, H = doc.landscape ? 595.28 : 841.89, M = 42
  const pages: PDFPage[] = []
  let page!: PDFPage, y = 0
  const newPage = () => { page = pdf.addPage([W, H]); pages.push(page); y = H - M }
  const need = (h: number) => { if (y - h < M + 18) newPage() }
  newPage()
  for (const l of wrap(doc.title, bold, 17, W - 2 * M)) { page.drawText(l, { x: M, y: y - 17, size: 17, font: bold, color: rgb(0.08, 0.3, 0.2) }); y -= 22 }
  if (doc.subtitle) for (const l of wrap(doc.subtitle, font, 9.5, W - 2 * M)) { page.drawText(l, { x: M, y: y - 10, size: 9.5, font, color: rgb(0.35, 0.35, 0.35) }); y -= 13 }
  y -= 6; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: rgb(0.08, 0.3, 0.2) }); y -= 12

  for (const b of doc.blocks) {
    if (b.t === 'h') { need(30); y -= 6; page.drawText(safe(b.text), { x: M, y: y - 12, size: 12, font: bold, color: rgb(0.08, 0.3, 0.2) }); y -= 20 }
    else if (b.t === 'p' || b.t === 'alert') {
      const ls = wrap(b.text, b.t === 'alert' ? bold : font, 10, W - 2 * M - (b.t === 'alert' ? 12 : 0))
      need(ls.length * 13 + 6)
      if (b.t === 'alert') page.drawRectangle({ x: M, y: y - ls.length * 13 - 2, width: W - 2 * M, height: ls.length * 13 + 6, color: rgb(0.99, 0.9, 0.89), borderColor: rgb(0.7, 0.1, 0.1), borderWidth: 0.8 })
      for (const l of ls) { page.drawText(l, { x: M + (b.t === 'alert' ? 6 : 0), y: y - 10, size: 10, font: b.t === 'alert' ? bold : font, color: b.t === 'alert' ? rgb(0.6, 0.05, 0.05) : rgb(0.1, 0.1, 0.1) }); y -= 13 }
      y -= 6
    } else if (b.t === 'kv') {
      for (const [k, v] of b.rows) {
        const ls = wrap(v, font, 10, W - 2 * M - 150); need(ls.length * 13)
        page.drawText(safe(k), { x: M, y: y - 10, size: 9.5, font: bold, color: rgb(0.3, 0.3, 0.3) })
        for (const l of ls) { page.drawText(l, { x: M + 150, y: y - 10, size: 10, font }); y -= 13 }
      }
      y -= 4
    } else {
      const total = W - 2 * M, ws = (b.widths ?? b.head.map(() => 1)), sum = ws.reduce((a, x) => a + x, 0), cw = ws.map((x) => (x / sum) * total)
      const drawRow = (cells: string[], isHead: boolean) => {
        const wrapped = cells.map((c, i) => wrap(c, isHead ? bold : font, 8.5, cw[i] - 6)), h = Math.max(...wrapped.map((l) => l.length)) * 11 + 5
        need(h)
        if (isHead) page.drawRectangle({ x: M, y: y - h, width: total, height: h, color: rgb(0.9, 0.95, 0.92) })
        let x = M
        wrapped.forEach((ls, i) => { ls.forEach((l, k) => page.drawText(l, { x: x + 3, y: y - 10 - k * 11, size: 8.5, font: isHead ? bold : font, color: rgb(0.1, 0.1, 0.1) })); x += cw[i] })
        y -= h; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.3, color: rgb(0.75, 0.75, 0.75) })
      }
      drawRow(b.head, true)
      for (const r of b.rows) drawRow(r, false)
      y -= 8
    }
  }
  const foot = safe(doc.footer ?? 'Documento gerado pelo NutriVida Pro. Conferir com o responsável técnico antes do uso.')
  pages.forEach((p, i) => p.drawText(`${foot}  -  pagina ${i + 1}/${pages.length}`, { x: M, y: 22, size: 7.5, font, color: rgb(0.5, 0.5, 0.5) }))
  return pdf.save()
}

export const pdfResponse = (bytes: Uint8Array, filename: string) =>
  new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })

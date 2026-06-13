/**
 * DocExtract seam — Node implementation (résumé import spec §3, Phase B).
 *
 * Exercises the real pdf-parse / mammoth parsers end-to-end over fixtures built
 * in-memory: a minimal one-page PDF and the same content as a DOCX must both
 * yield the same text, so a résumé imported either way lands the same items.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodePlatform } from './platform-node';

/** Build a minimal but structurally valid single-page PDF with one text line
 * per entry, computing the xref offsets so pdf.js parses it without recovery. */
function makePdf(lines: string[]): Buffer {
  const header = '%PDF-1.4\n';
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  const esc = (s: string): string => s.replace(/[\\()]/g, '\\$&');
  let stream = 'BT /F1 18 Tf 16 TL 72 720 Td\n';
  lines.forEach((l, i) => {
    stream += (i ? 'T*\n' : '') + `(${esc(l)}) Tj\n`;
  });
  stream += 'ET';
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let body = header;
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const trailer = `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

/** Build a minimal valid .docx (OOXML zip) with one paragraph per line. */
async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip
    .folder('_rels')!
    .file(
      '.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
    );
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  zip
    .folder('word')!
    .file(
      'document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`
    );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const LINES = ['Senior Engineer - Bloomberg L.P.', 'Mar 2019 - Present'];

describe('Node DocExtract (résumé spec §3)', () => {
  let dir: string;
  const docs = createNodePlatform(':memory:').docs!;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whoami-docs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts text from a PDF', async () => {
    const path = join(dir, 'resume.pdf');
    await writeFile(path, makePdf(LINES));
    const out = await docs.extractText(path);
    expect(out.kind).toBe('pdf');
    expect(out.pageCount).toBe(1);
    expect(out.text).toContain('Senior Engineer - Bloomberg L.P.');
    expect(out.text).toContain('Mar 2019 - Present');
  });

  it('extracts text from a DOCX', async () => {
    const path = join(dir, 'resume.docx');
    await writeFile(path, await makeDocx(LINES));
    const out = await docs.extractText(path);
    expect(out.kind).toBe('docx');
    expect(out.text).toContain('Senior Engineer - Bloomberg L.P.');
    expect(out.text).toContain('Mar 2019 - Present');
  });

  it('a PDF and the same content as a DOCX yield the same lines', async () => {
    const pdfPath = join(dir, 'r.pdf');
    const docxPath = join(dir, 'r.docx');
    await writeFile(pdfPath, makePdf(LINES));
    await writeFile(docxPath, await makeDocx(LINES));
    const pdf = await docs.extractText(pdfPath);
    const docx = await docs.extractText(docxPath);
    for (const line of LINES) {
      expect(pdf.text).toContain(line);
      expect(docx.text).toContain(line);
    }
  });

  it('throws on an unsupported format (the action then disables import)', async () => {
    const path = join(dir, 'resume.txt');
    await writeFile(path, 'plain text');
    await expect(docs.extractText(path)).rejects.toThrow(/expected \.pdf or \.docx/);
  });
});

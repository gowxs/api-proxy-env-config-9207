import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  lines.forEach((line, i) => page.drawText(line, { x: 50, y: 800 - i * 20, size: 12, font }));
  return doc.save();
}

export async function makeDocx(heading: string, paragraphs: string[]): Promise<Uint8Array> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }),
          ...paragraphs.map((p) => new Paragraph({ text: p })),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** Tiny static site on 127.0.0.1 for crawler tests. */
export async function serveSite(
  routes: Record<string, { status?: number; type?: string; body: string; location?: string }>,
) {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    hits.push(path);
    const r = routes[path];
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res
      .writeHead(r.status ?? 200, {
        'content-type': r.type ?? 'text/html; charset=utf-8',
        ...(r.location ? { location: r.location } : {}),
      })
      .end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

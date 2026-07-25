import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';

const FIXTURE_DIRECTORY = join(tmpdir(), 'omnia-reader-native-e2e');

export const NATIVE_PROFILE_DIRECTORIES = {
  data: join(FIXTURE_DIRECTORY, 'data'),
  config: join(FIXTURE_DIRECTORY, 'config'),
  cache: join(FIXTURE_DIRECTORY, 'cache'),
};
export const NATIVE_PDF_FIXTURE = join(
  FIXTURE_DIRECTORY,
  'omnia-native-fixture.pdf',
);
export const NATIVE_EPUB_FIXTURE = join(
  FIXTURE_DIRECTORY,
  'omnia-native-fixture.epub',
);

export async function prepareNativeFixtures() {
  await rm(FIXTURE_DIRECTORY, { recursive: true, force: true });
  await mkdir(FIXTURE_DIRECTORY, { recursive: true });
  await Promise.all([
    ...Object.values(NATIVE_PROFILE_DIRECTORIES).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
    writeFile(NATIVE_PDF_FIXTURE, createNativePdfFixture()),
    writeFile(NATIVE_EPUB_FIXTURE, await createNativeEpubFixture()),
  ]);
}

async function createNativeEpubFixture() {
  const archive = new JSZip();
  archive.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  archive.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  archive.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:omnia-native-e2e</dc:identifier>
    <dc:title>Omnia Native EPUB Fixture</dc:title>
    <dc:creator>Omnia Test Suite</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-07-25T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter-1"/>
    <itemref idref="chapter-2"/>
  </spine>
</package>`,
  );
  archive.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
      <ol>
        <li><a href="chapter-1.xhtml">Native Chapter One</a></li>
        <li><a href="chapter-2.xhtml">Native Chapter Two</a></li>
      </ol>
    </nav>
  </body>
</html>`,
  );
  archive.file(
    'OEBPS/chapter-1.xhtml',
    epubChapter(
      'Native Chapter One',
      'This chapter arrived through the desktop startup file association.',
    ),
  );
  archive.file(
    'OEBPS/chapter-2.xhtml',
    epubChapter(
      'Native Chapter Two',
      'This chapter proves navigation in the actual Tauri webview.',
    ),
  );
  return archive.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'STORE',
  });
}

function epubChapter(title, paragraph) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <p>${paragraph}</p>
  </body>
</html>`;
}

function createNativePdfFixture() {
  const pages = [
    'BT /F1 18 Tf 72 720 Td (Omnia Native PDF Fixture - Page One) Tj ET',
    'BT /F1 18 Tf 72 720 Td (Omnia Native PDF Fixture - Page Two) Tj ET',
  ];
  const pageObjectStart = 3;
  const contentObjectStart = pageObjectStart + pages.length;
  const fontObject = contentObjectStart + pages.length;
  const infoObject = fontObject + 1;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages
      .map((_, index) => `${pageObjectStart + index} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`,
    ...pages.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`,
    ),
    ...pages.map(
      (page) =>
        `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`,
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (Omnia Native PDF Fixture) /Author (Omnia Test Suite) >>',
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n`;
  content += '0000000000 65535 f \n';
  content += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\n`;
  content += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(content);
}

import JSZip from 'jszip';

export async function createEpubFixture(): Promise<Buffer> {
  const archive = new JSZip();
  const longChapter = Array.from(
    { length: 64 },
    (_, index) =>
      `<p>Reading page fixture paragraph ${index + 1}. ` +
      'A universal reader must preserve comfortable typography while ' +
      'moving through every generated page without clipping content. ' +
      'This deliberately long chapter verifies that previous and next ' +
      'move through page spreads before crossing the chapter boundary.</p>',
  ).join('\n');
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
    <dc:identifier id="book-id">urn:uuid:omnia-e2e</dc:identifier>
    <dc:title>Omnia EPUB Fixture</dc:title>
    <dc:creator>Omnia Test Suite</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-07-24T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="navigation/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
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
    'OEBPS/cover.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEUlEQVR4nGMw1Gs01GtkQKEANVUFQSVf9GgAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  archive.file(
    'OEBPS/navigation/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
      <ol>
        <li><a href="../chapter-1.xhtml#preface">Preface</a></li>
        <li>
          <a href="../chapter-1.xhtml">Chapter One</a>
          <ol>
            <li><a href="#introduction">Introduction</a></li>
          </ol>
        </li>
        <li><a href="../chapter-2.xhtml">Chapter Two</a></li>
      </ol>
    </nav>
    <nav epub:type="landmarks" xmlns:epub="http://www.idpf.org/2007/ops">
      <ol>
        <li>
          <a epub:type="preface" href="../chapter-1.xhtml#preface">Preface</a>
        </li>
      </ol>
    </nav>
  </body>
</html>`,
  );
  archive.file(
    'OEBPS/chapter-1.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Chapter One</title>
    <meta http-equiv="refresh" content="0;url=https://tracking.invalid/refresh"/>
    <link rel="stylesheet" href="https://tracking.invalid/publication.css"/>
    <style>@import "https://tracking.invalid/imported.css";</style>
  </head>
  <body>
    <h1 id="preface">Preface</h1>
    <h1>Chapter One</h1>
    <h2 id="introduction">Introduction</h2>
    <p>This is the first EPUB fixture chapter.</p>
    <button type="button" onclick="window.parent.postMessage('epub-script-executed', '*')">Unsafe publication action</button>
    <a href="javascript:window.parent.postMessage('epub-script-executed', '*')">Unsafe publication link</a>
    <img id="remote-tracker" src="https://tracking.invalid/pixel.png" alt="Remote tracker"/>
    <iframe src="https://tracking.invalid/frame"></iframe>
    <form action="https://tracking.invalid/submit"><button formaction="/alternate-submit">Unsafe form</button></form>
    <div id="remote-style" style="background-image:url(https://tracking.invalid/background.png)">Unsafe remote style</div>
    ${longChapter}
  </body>
</html>`,
  );
  archive.file(
    'OEBPS/chapter-2.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter Two</title></head>
  <body>
    <h1>Chapter Two</h1>
    <p>This is the second EPUB fixture chapter.</p>
  </body>
</html>`,
  );

  return archive.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
  });
}

export async function createLargeEpubFixture(
  chapterCount = 80,
  paragraphsPerChapter = 48,
): Promise<Buffer> {
  if (chapterCount < 2 || paragraphsPerChapter < 1) {
    throw new RangeError(
      'Large EPUB fixtures require at least two chapters and one paragraph',
    );
  }

  const archive = new JSZip();
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const chapterNumber = index + 1;
    return {
      id: `chapter-${chapterNumber}`,
      href: `chapter-${chapterNumber}.xhtml`,
      title: `Chapter ${chapterNumber}`,
    };
  });
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
    <dc:identifier id="book-id">urn:uuid:omnia-large-e2e</dc:identifier>
    <dc:title>Omnia Large EPUB Fixture</dc:title>
    <dc:creator>Omnia Test Suite</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-07-25T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${chapters
      .map(
        ({ id, href }) =>
          `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`,
      )
      .join('\n    ')}
  </manifest>
  <spine>
    ${chapters.map(({ id }) => `<itemref idref="${id}"/>`).join('\n    ')}
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
        ${chapters
          .map(({ href, title }) => `<li><a href="${href}">${title}</a></li>`)
          .join('\n        ')}
      </ol>
    </nav>
  </body>
</html>`,
  );
  for (const { href, title } of chapters) {
    const paragraphs = Array.from(
      { length: paragraphsPerChapter },
      (_, index) =>
        `<p>${title}, paragraph ${index + 1}. ` +
        'This representative large-publication fixture exercises incremental ' +
        'EPUB rendering, pagination, keyboard navigation, and deterministic ' +
        'resource cleanup without loading every spine item into the document.</p>',
    ).join('\n    ');
    archive.file(
      `OEBPS/${href}`,
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    ${paragraphs}
  </body>
</html>`,
    );
  }

  return archive.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'STORE',
  });
}

export async function createFixedLayoutRtlEpubFixture(): Promise<Buffer> {
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
    <dc:identifier id="book-id">urn:uuid:omnia-fixed-rtl-e2e</dc:identifier>
    <dc:title>Omnia Fixed RTL Fixture</dc:title>
    <dc:creator>Omnia Test Suite</dc:creator>
    <dc:language>ar</dc:language>
    <meta property="dcterms:modified">2026-07-25T00:00:00Z</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">none</meta>
    <meta property="rendition:orientation">portrait</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="page-1" href="page-1.xhtml" media-type="application/xhtml+xml"/>
    <item id="page-2" href="page-2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="page-1"/>
    <itemref idref="page-2"/>
  </spine>
</package>`,
  );
  archive.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" dir="rtl">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops">
      <ol>
        <li><a href="page-1.xhtml">Fixed Page One</a></li>
        <li><a href="page-2.xhtml#destination">Fixed Page Two</a></li>
      </ol>
    </nav>
  </body>
</html>`,
  );
  archive.file(
    'OEBPS/page-1.xhtml',
    fixedLayoutPage(
      'Fixed RTL Page One',
      `<p>هذه هي الصفحة الأولى ذات التخطيط الثابت.</p>
       <a id="internal-link" href="page-2.xhtml#destination">Continue inside this book</a>
       <a id="external-link" href="https://example.com/omnia-reader">Visit the external reference</a>
       <a id="blocked-link" href="mailto:reader@example.com">Unsupported mail link</a>`,
    ),
  );
  archive.file(
    'OEBPS/page-2.xhtml',
    fixedLayoutPage(
      'Fixed RTL Page Two',
      `<p id="destination">هذه هي الصفحة الثانية ذات التخطيط الثابت.</p>`,
    ),
  );

  return archive.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
  });
}

function fixedLayoutPage(title: string, contents: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" dir="rtl">
  <head>
    <title>${title}</title>
    <meta name="viewport" content="width=800,height=1200"/>
    <style>
      html, body { width: 800px; height: 1200px; margin: 0; overflow: hidden; }
      body {
        box-sizing: border-box;
        background: #fff4cc;
        color: #312e81;
        font-family: serif;
        font-size: 42px;
        padding: 96px;
      }
      a { display: block; margin-top: 48px; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    ${contents}
  </body>
</html>`;
}

export async function createMalformedEpubFixture(): Promise<Buffer> {
  const archive = new JSZip();
  archive.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  archive.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/missing-package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  return archive.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
  });
}

export function createPdfFixture(): Buffer {
  const pages = [
    `BT /F1 18 Tf 72 720 Td (Omnia PDF Fixture - Page One) Tj ET
BT /F1 12 Tf 72 660 Td (Reader name:) Tj ET
BT /F1 12 Tf 72 610 Td (Visit the external reference) Tj ET
BT /F1 12 Tf 72 565 Td (Continue to page two) Tj ET`,
    'BT /F1 18 Tf 72 720 Td (Omnia PDF Fixture - Page Two) Tj ET',
  ];
  return buildPdfFixture(pages, 'Omnia PDF Fixture', true);
}

export function createMalformedPdfFixture(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
}

export function createEncryptedPdfFixture(): Buffer {
  return Buffer.from(
    [
      'JVBERi0xLjcKJb/3ov4KMSAwIG9iago8PCAvRXh0ZW5zaW9ucyA8PCAvQURCRSA8PCAvQmFzZVZlcnNpb24gLzEuNyAvRXh0ZW5z',
      'aW9uTGV2ZWwgOCA+PiA+PiAvUGFnZXMgMyAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0F1dGhvciA8',
      'M2EyZTBjNjVkMTFkM2RiN2Y4ODVkY2YzZmZiM2Q0NzM2Y2U5YmExNTc3MjY1MDhiMGY3NWNkNTk1NGE5ZGE0MTA5MGY4ODU4OTk5',
      'YzUyMDdkZTYxNzAxOGViMWMwZTAyPiAvVGl0bGUgPDk5ZjEyODU0MTE2MzgwMjc5MzY0NjY1NGQxYjc5ZjNlMGU1M2E5ZmRhZjM3',
      'ZTYyYmI1N2Q5MDRmOGQyYTdiYzFkMjg1MGFjM2VmMTlmNWY0MWM1MjU1MTE2ZDIzOTQzNz4gPj4KZW5kb2JqCjMgMCBvYmoKPDwg',
      'L0NvdW50IDIgL0tpZHMgWyA0IDAgUiA1IDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKNCAwIG9iago8PCAvQ29udGVudHMg',
      'NiAwIFIgL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXSAvUGFyZW50IDMgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDcg',
      'MCBSID4+ID4+IC9UeXBlIC9QYWdlID4+CmVuZG9iago1IDAgb2JqCjw8IC9Db250ZW50cyA4IDAgUiAvTWVkaWFCb3ggWyAwIDAg',
      'NjEyIDc5MiBdIC9QYXJlbnQgMyAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNyAwIFIgPj4gPj4gL1R5cGUgL1BhZ2Ug',
      'Pj4KZW5kb2JqCjYgMCBvYmoKPDwgL0xlbmd0aCA5NiAvRmlsdGVyIC9GbGF0ZURlY29kZSA+PgpzdHJlYW0KhA1KVY9sZYwCLZTQ',
      'qECFMnZRnTWfggwdvT4TNN2iR6xo8iouJQ4R395i90HRpPx8VUvWtBYxTPTUGl5gjQLYUKtWpIRkpxmF9xrCcW4YaFBCfWZ71GAt',
      'NeRWi6BPKFRoZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9CYXNlRm9udCAvSGVsdmV0aWNhIC9TdWJ0eXBlIC9UeXBlMSAv',
      'VHlwZSAvRm9udCA+PgplbmRvYmoKOCAwIG9iago8PCAvTGVuZ3RoIDk2IC9GaWx0ZXIgL0ZsYXRlRGVjb2RlID4+CnN0cmVhbQrY',
      'FNnjJZYu+Uxnr//qUv4MAT2x5Gm8uctTzN810xzLv9Bcbv668KR95rZ+H825R7hCdXJ6ZVk7wih91qykeY30ozWpxuEs8S7hUcZw',
      '/rRUyC42atGcvAxORE+S1aNm/7llbmRzdHJlYW0KZW5kb2JqCjkgMCBvYmoKPDwgL0NGIDw8IC9TdGRDRiA8PCAvQXV0aEV2ZW50',
      'IC9Eb2NPcGVuIC9DRk0gL0FFU1YzIC9MZW5ndGggMzIgPj4gPj4gL0ZpbHRlciAvU3RhbmRhcmQgL0xlbmd0aCAyNTYgL08gPDYz',
      'YjI3ZGU2NWM2YjNkOTAwZTEzYjkwOThlMGFkZWNiMWQwNjg2OGZlNzYzZTE4YWFjY2MyMjUzZGRkNGYzNjExYmE3ZThkYTUyYmM2',
      'MzQ1MzIyYWVmMjk3OWI5OTJmND4gL09FIDwyOTkwYThmZjM3YzI0NDNiOWQwMTU2ZDljMTc3NGI2Njg4YzBhZGRmNGYzMGY2MThm',
      'ZWM1ZTc3ZjY2MzUyYzY2PiAvUCAtNCAvUGVybXMgPDdmYWY1MGJkOGI5NTY1NmIwOTE0MDcyMzQ3MTY2NzA4PiAvUiA2IC9TdG1G',
      'IC9TdGRDRiAvU3RyRiAvU3RkQ0YgL1UgPDdkMDE2OGVmZjhhOTU5ZmU4ZDdmYjc5ZDNiZmE1ZGUwNzIxZDg5MDdkNzNlMGI3MTdm',
      'NDhjMTA1MWMzOTlhMjdkMTdjOGZhMDU5ZTViZGY1YWM4NzBhZTM5MzQxMzhjNT4gL1VFIDwwOWJkYzUzZmNjMTY3ZTM4ZjhmYjQ2',
      'OTE1NmM2NDZjMGQ0YzVkY2YyZGM4OGY0M2E4ZWJiYjhiNmYwZGVhN2IxPiAvViA1ID4+CmVuZG9iagp4cmVmCjAgMTAKMDAwMDAw',
      'MDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMzAgMDAwMDAgbiAKMDAwMDAwMDM2NCAwMDAwMCBuIAow',
      'MDAwMDAwNDI5IDAwMDAwIG4gCjAwMDAwMDA1NTcgMDAwMDAgbiAKMDAwMDAwMDY4NSAwMDAwMCBuIAowMDAwMDAwODUxIDAwMDAw',
      'IG4gCjAwMDAwMDA5MjEgMDAwMDAgbiAKMDAwMDAwMTA4NyAwMDAwMCBuIAp0cmFpbGVyIDw8IC9JbmZvIDIgMCBSIC9Sb290IDEg',
      'MCBSIC9TaXplIDEwIC9JRCBbPGFhMzYyOWRiY2E2ZDMzNDJjZGNkMTk2MjI1OWFiMTVjPjxhYTM2MjlkYmNhNmQzMzQyY2RjZDE5',
      'NjIyNTlhYjE1Yz5dIC9FbmNyeXB0IDkgMCBSID4+CnN0YXJ0eHJlZgoxNjM0CiUlRU9GCg==',
    ].join(''),
    'base64',
  );
}

export function createLargePdfFixture(pageCount = 180): Buffer {
  if (!Number.isSafeInteger(pageCount) || pageCount < 2) {
    throw new RangeError('Large PDF fixtures require at least two pages');
  }

  return buildPdfFixture(
    Array.from(
      { length: pageCount },
      (_, index) =>
        `BT /F1 18 Tf 72 720 Td (Omnia Large PDF Fixture - Page ${index + 1}) Tj ET`,
    ),
    'Omnia Large PDF Fixture',
  );
}

function buildPdfFixture(
  pages: readonly string[],
  title: string,
  interactive = false,
): Buffer {
  if (interactive && pages.length < 2) {
    throw new RangeError('Interactive PDF fixtures require at least two pages');
  }

  const pageObjectStart = 3;
  const contentObjectStart = pageObjectStart + pages.length;
  const fontObject = contentObjectStart + pages.length;
  const infoObject = fontObject + 1;
  const externalLinkObject = infoObject + 1;
  const internalLinkObject = externalLinkObject + 1;
  const formWidgetObject = internalLinkObject + 1;
  const acroFormObject = formWidgetObject + 1;
  const firstPageAnnotations = interactive
    ? ` /Annots [${externalLinkObject} 0 R ${internalLinkObject} 0 R ${formWidgetObject} 0 R]`
    : '';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${interactive ? ` /AcroForm ${acroFormObject} 0 R` : ''} >>`,
    `<< /Type /Pages /Kids [${pages
      .map((_, index) => `${pageObjectStart + index} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`,
    ...pages.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectStart + index} 0 R${index === 0 ? firstPageAnnotations : ''} >>`,
    ),
    ...pages.map(
      (page) =>
        `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`,
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${title}) /Author (Omnia Test Suite) >>`,
    ...(interactive
      ? [
          '<< /Type /Annot /Subtype /Link /Rect [72 596 280 626] /Border [0 0 1] /Contents (Visit the external reference) /A << /S /URI /URI (https://example.com/omnia-reader-pdf) >> >>',
          `<< /Type /Annot /Subtype /Link /Rect [72 551 280 581] /Border [0 0 1] /Contents (Continue to page two) /Dest [${pageObjectStart + 1} 0 R /Fit] >>`,
          `<< /Type /Annot /Subtype /Widget /FT /Tx /T (reader-name) /TU (Reader name) /Rect [160 646 390 676] /V () /DA (/F1 12 Tf 0 g) /P ${pageObjectStart} 0 R >>`,
          `<< /Fields [${formWidgetObject} 0 R] /NeedAppearances true /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 ${fontObject} 0 R >> >> >>`,
        ]
      : []),
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

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

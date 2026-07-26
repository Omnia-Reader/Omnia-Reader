# Representative Publication Corpus

Omnia Reader's deterministic generated fixtures cover targeted EPUB and PDF
behaviors without network access. The opt-in representative corpus complements
them with independently authored EPUBs from the W3C EPUB 3 Community Group's
sample collection and the Readium EPUB testing corpus.

The test downloads hash-pinned upstream assets only when
`REPRESENTATIVE_PUBLICATIONS_E2E=1`, validates their exact byte length and
SHA-256 digest before browser import, and never stores the publications in the
application source tree.

| Publication                 | Coverage                                                        | License      | Bytes     | SHA-256                                                            |
| --------------------------- | --------------------------------------------------------------- | ------------ | --------- | ------------------------------------------------------------------ |
| Moby-Dick                   | 136-chapter navigation, embedded fonts, search, resume          | CC BY-SA 3.0 | 1,628,868 | `81bc079841a38e91a02a7776d04786a2fc311cfd300064e9fc533ce7c54cf7b4` |
| Israel Sailing              | Hebrew text, embedded fonts, authored RTL progression           | CC BY-SA 2.5 | 1,358,190 | `10c397036d2eb54db172d05c9e3cda4382d04e8e9ce3ddd8741ba7058c3dcd4a` |
| Voyage of Life              | Mixed reflowable and item-level fixed-layout sections           | CC BY-SA 3.0 | 970,980   | `e38ed606ff604e638f737efaf66e0fd0b2997c3eab7432bcba9a00a81a925cf3` |
| Vertically Scrollable Manga | Authored `scrolled-doc`, natural wheel scrolling, flow override | CC BY-SA 3.0 | 5,826,314 | `7ae9b49244218947a45c43f1d22ece95b52ea09f470edf239cd179a346c00269` |
| Readium EPUB 2 Smoke Test   | EPUB 2 package, NCX ToC, embedded fonts, chapter navigation     | Not stated   | 279,280   | `84dad47591636e07b8eaceb80edc5a16bc08ce4cecc109d0c61afd44e4ba62ed` |

Sources:

- [EPUB 3 Samples project](https://idpf.github.io/epub3-samples/30/samples.html)
- [Moby-Dick release asset](https://github.com/IDPF/epub3-samples/releases/download/20230704/moby-dick.epub)
- [Israel Sailing release asset](https://github.com/IDPF/epub3-samples/releases/download/20230704/israelsailing.epub)
- [Voyage of Life release asset](https://github.com/IDPF/epub3-samples/releases/download/20230704/cole-voyage-of-life.epub)
- [Vertically Scrollable Manga release asset](https://github.com/IDPF/epub3-samples/releases/download/20230704/vertically-scrollable-manga.epub)
- [Readium Testing Resources](https://readium.org/readium-test-files/)
- [Readium EPUB 2 Smoke Test at pinned source revision](https://raw.githubusercontent.com/readium/readium-test-files/743a3c973168e67be791787fe1c2b917ea98e56d/functional/smoke-tests/SmokeTest-EPUB2/SmokeTest-EPUB2.epub)

Run the supported Chromium/WebKit compatibility gate after the production web
build:

```sh
REPRESENTATIVE_PUBLICATIONS_E2E=1 npx playwright test \
  --config apps/omnia-reader-e2e/playwright.config.ts \
  apps/omnia-reader-e2e/src/representative-publications.spec.ts
```

This gate is intentionally opt-in: ordinary application builds and the active
local E2E matrix stay deterministic, network-independent, and usable offline.
Firefox is temporarily excluded from the supported automated matrix while app
feature work has priority; set `FIREFOX_E2E=1` only for explicit diagnostics.

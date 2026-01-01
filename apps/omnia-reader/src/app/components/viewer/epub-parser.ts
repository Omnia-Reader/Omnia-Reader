import JSZip from 'jszip';

export interface EpubMetadata {
  title: string;
  author: string;
  language: string;
}

export interface EpubSpineItem {
  id: string;
  href: string;
  mediaType: string;
}

export interface TocItem {
  label: string;
  href: string;
  spineIndex: number;
  anchor?: string; // Fragment identifier (e.g., "section-2-3" from "chapter.xhtml#section-2-3")
  chapterNumber?: string; // Hierarchical chapter number (e.g., "1", "1.1", "1.2.3")
  children?: TocItem[];
}


export class EpubParser {
  private zip: JSZip | null = null;
  private rootPath = '';
  private contentPath = '';

  async loadFromFile(file: File): Promise<void> {
    this.zip = await JSZip.loadAsync(file);
  }

  async getMetadata(): Promise<EpubMetadata> {
    if (!this.zip) throw new Error('EPUB not loaded');

    // Find and parse container.xml
    const containerXml = await this.getFileAsText('META-INF/container.xml');
    const rootFilePath = this.extractRootFilePath(containerXml);

    this.rootPath = rootFilePath.substring(0, rootFilePath.lastIndexOf('/') + 1);
    this.contentPath = this.rootPath;

    // Parse content.opf
    const contentOpf = await this.getFileAsText(rootFilePath);
    return this.extractMetadata(contentOpf);
  }

  async getSpine(): Promise<EpubSpineItem[]> {
    if (!this.zip) throw new Error('EPUB not loaded');

    const contentOpf = await this.getFileAsText(this.rootPath + 'content.opf').catch(() =>
      this.getFileAsText(this.rootPath + 'package.opf')
    );

    return this.extractSpine(contentOpf);
  }

  async getTableOfContents(spine: EpubSpineItem[]): Promise<TocItem[]> {
    if (!this.zip) throw new Error('EPUB not loaded');

    try {
      // Try to find nav.xhtml (EPUB 3)
      const navPath = await this.findNavigationDocument();
      if (navPath) {
        const navContent = await this.getFileAsText(navPath);
        return this.parseNavDocument(navContent, spine);
      }

      // Fallback: try toc.ncx (EPUB 2)
      const ncxPath = this.rootPath + 'toc.ncx';
      const ncxContent = await this.getFileAsText(ncxPath);
      return this.parseNcxDocument(ncxContent, spine);
    } catch (err) {
      console.warn('Could not parse TOC:', err);
      // Fallback: create simple TOC from spine
      return this.createTocFromSpine(spine);
    }
  }

  async getChapterContent(href: string): Promise<string> {
    if (!this.zip) throw new Error('EPUB not loaded');

    console.log('getChapterContent called with href:', href);
    console.log('contentPath:', this.contentPath);

    const fullPath = this.contentPath + href;
    console.log('Attempting to load file at path:', fullPath);

    let content = await this.getFileAsText(fullPath);
    console.log('✅ File loaded successfully, content length:', content.length);

    // Process images and resources to use blob URLs
    content = await this.processResources(content, href);
    console.log('✅ Resources processed');

    return content;
  }

  async extractStylesheets(): Promise<string[]> {
    if (!this.zip) throw new Error('EPUB not loaded');

    const stylesheets: string[] = [];

    try {
      // Get all CSS files referenced in the OPF manifest
      const contentOpf = await this.getFileAsText(this.rootPath + 'content.opf').catch(() =>
        this.getFileAsText(this.rootPath + 'package.opf')
      );

      const parser = new DOMParser();
      const doc = parser.parseFromString(contentOpf, 'text/xml');

      // Find all CSS files in manifest
      const cssItems = doc.querySelectorAll('manifest item[media-type="text/css"]');

      for (const item of Array.from(cssItems)) {
        const href = item.getAttribute('href');
        if (href) {
          try {
            const cssPath = this.contentPath + href;
            const cssContent = await this.getFileAsText(cssPath);
            stylesheets.push(cssContent);
            console.log('✅ Loaded stylesheet:', href);
          } catch (err) {
            console.warn('Failed to load stylesheet:', href, err);
          }
        }
      }

      console.log(`✅ Extracted ${stylesheets.length} stylesheets from EPUB`);
    } catch (err) {
      console.warn('Failed to extract stylesheets:', err);
    }

    return stylesheets;
  }

  private async getFileAsText(path: string): Promise<string> {
    if (!this.zip) throw new Error('EPUB not loaded');

    const file = this.zip.file(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    return await file.async('text');
  }

  private async getFileAsBlob(path: string): Promise<Blob> {
    if (!this.zip) throw new Error('EPUB not loaded');

    const file = this.zip.file(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    return await file.async('blob');
  }

  private extractRootFilePath(containerXml: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(containerXml, 'text/xml');
    const rootFile = doc.querySelector('rootfile');
    return rootFile?.getAttribute('full-path') || 'content.opf';
  }

  private extractMetadata(contentOpf: string): EpubMetadata {
    const parser = new DOMParser();
    const doc = parser.parseFromString(contentOpf, 'text/xml');

    const getTextContent = (selector: string): string => {
      const element = doc.querySelector(selector);
      return element?.textContent?.trim() || 'Unknown';
    };

    return {
      title: getTextContent('title'),
      author: getTextContent('creator'),
      language: getTextContent('language')
    };
  }

  private extractSpine(contentOpf: string): EpubSpineItem[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(contentOpf, 'text/xml');

    // Build manifest map
    const manifestMap = new Map<string, { href: string; mediaType: string }>();
    const manifestItems = doc.querySelectorAll('manifest item');
    manifestItems.forEach(item => {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type');
      if (id && href) {
        manifestMap.set(id, { href, mediaType: mediaType || 'text/html' });
      }
    });

    // Build spine
    const spine: EpubSpineItem[] = [];
    const spineItems = doc.querySelectorAll('spine itemref');
    spineItems.forEach(item => {
      const idref = item.getAttribute('idref');
      if (idref && manifestMap.has(idref)) {
        const manifestItem = manifestMap.get(idref);
        if (manifestItem) {
          spine.push({
            id: idref,
            href: manifestItem.href,
            mediaType: manifestItem.mediaType
          });
        }
      }
    });

    return spine;
  }

  private async processResources(content: string, currentHref: string): Promise<string> {
    if (!this.zip) return content;

    const currentDir = currentHref.substring(0, currentHref.lastIndexOf('/') + 1);

    // Process images
    const imgRegex = /<img[^>]+src=["']([^"']+)["']/g;
    const matches = Array.from(content.matchAll(imgRegex));

    for (const match of matches) {
      const src = match[1];
      if (src.startsWith('data:') || src.startsWith('http')) continue;

      try {
        const imagePath = this.resolvePath(this.contentPath + currentDir, src);
        const blob = await this.getFileAsBlob(imagePath);
        const blobUrl = URL.createObjectURL(blob);
        content = content.replace(src, blobUrl);
      } catch (err) {
        console.warn(`Failed to load image: ${src}`, err);
      }
    }

    return content;
  }

  private resolvePath(base: string, relative: string): string {
    if (relative.startsWith('/')) return relative.substring(1);

    const baseParts = base.split('/').filter(p => p);
    const relativeParts = relative.split('/').filter(p => p);

    for (const part of relativeParts) {
      if (part === '..') {
        baseParts.pop();
      } else if (part !== '.') {
        baseParts.push(part);
      }
    }

    return baseParts.join('/');
  }

  private async findNavigationDocument(): Promise<string | null> {
    try {
      // Look for navigation document in the EPUB
      const contentOpf = await this.getFileAsText(this.rootPath + 'content.opf').catch(() =>
        this.getFileAsText(this.rootPath + 'package.opf')
      );

      const parser = new DOMParser();
      const doc = parser.parseFromString(contentOpf, 'text/xml');

      // EPUB 3: Look for nav document
      const navItem = doc.querySelector('manifest item[properties*="nav"]');
      if (navItem) {
        const href = navItem.getAttribute('href');
        return href ? this.rootPath + href : null;
      }

      return null;
    } catch {
      return null;
    }
  }

  private parseNavDocument(navContent: string, spine: EpubSpineItem[]): TocItem[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(navContent, 'text/html');
    const nav = doc.querySelector('nav[*|type="toc"], nav#toc');

    if (!nav) return this.createTocFromSpine(spine);

    const parseNavList = (ol: Element, parentNumber = ''): TocItem[] => {
      const items: TocItem[] = [];
      const listItems = Array.from(ol.children).filter(el => el.tagName.toLowerCase() === 'li');

      let chapterCounter = 0; // Track only numbered chapters

      listItems.forEach((li) => {
        const anchor = li.querySelector('a');
        if (!anchor) return;

        const label = anchor.textContent?.trim() || 'Untitled';
        const fullHref = anchor.getAttribute('href') || '';

        // Split href into file and anchor parts
        const [file, anchorFragment] = fullHref.split('#');
        const spineIndex = this.findSpineIndex(file || fullHref, spine);

        // Determine if this item should be numbered
        // If parent is marked as NO_NUMBER, this child should also not be numbered
        const shouldNumber = parentNumber === 'NO_NUMBER'
          ? false
          : this.shouldNumberChapter(label);

        let chapterNumber: string | undefined;

        if (shouldNumber) {
          chapterCounter++;
          // Generate hierarchical chapter number
          chapterNumber = parentNumber && parentNumber !== 'NO_NUMBER'
            ? `${parentNumber}.${chapterCounter}`
            : `${chapterCounter}`;
        }

        const item: TocItem = {
          label,
          href: file || fullHref,
          spineIndex,
          anchor: anchorFragment,
          chapterNumber
        };

        // Check for nested list
        const nestedOl = li.querySelector('ol');
        if (nestedOl) {
          // Children inherit parent's chapter number
          // If parent is not numbered (chapterNumber is undefined), pass a special marker
          // to indicate children should also not be numbered
          if (chapterNumber) {
            item.children = parseNavList(nestedOl, chapterNumber);
          } else {
            // Parent is not numbered, so parse children with special marker
            item.children = parseNavList(nestedOl, 'NO_NUMBER');
          }
        }

        items.push(item);
      });

      return items;
    };

    const ol = nav.querySelector('ol');
    return ol ? parseNavList(ol) : this.createTocFromSpine(spine);
  }

  private shouldNumberChapter(label: string): boolean {
    const lowerLabel = label.toLowerCase().trim();

    // PRIORITY 1: Explicit chapter indicators - always number these
    if (/^(chapter|ch\.?)\s*\d+/i.test(lowerLabel)) {
      return true; // "Chapter 1", "Chapter 4: Introduction", etc.
    }

    // PRIORITY 2: Explicit part indicators - number these
    if (/^part\s+\d+/i.test(lowerLabel)) {
      return true; // "Part 1", "Part 2", etc.
    }

    // PRIORITY 3: Roman numeral chapters - number these
    if (/^(i{1,3}|iv|v|vi{0,3}|ix|x|xi{0,3})\.?\s/i.test(lowerLabel)) {
      return true; // "I. Introduction", "II. Main Content", etc.
    }

    // PRIORITY 4: Pure numeric start - likely a chapter
    if (/^\d+\.?\s/.test(lowerLabel)) {
      return true; // "1. Introduction", "2. Getting Started", etc.
    }

    // PRIORITY 5: Check for front matter (should NOT be numbered)
    // Use word boundaries to avoid false matches in chapter titles
    const frontMatter = [
      'cover', 'title page', 'copyright', 'dedication', 'epigraph',
      'foreword', 'preface', 'acknowledgments?', 'acknowledgements?',
      'prologue', 'contributors?', 'about the authors?',
      'about this book', 'table of contents', 'toc'
    ];

    for (const term of frontMatter) {
      // Match as whole word or at start of label
      const pattern = new RegExp(`^${term}(?:\\s|$|:)`, 'i');
      if (pattern.test(lowerLabel)) {
        return false;
      }
    }

    // PRIORITY 6: Check for back matter (should NOT be numbered)
    const backMatter = [
      'appendix', 'appendices', 'glossary', 'bibliography', 'references',
      'index', 'indices', 'epilogue', 'afterword',
      'about the publishers?', 'colophon'
    ];

    for (const term of backMatter) {
      // Match as whole word or at start of label
      const pattern = new RegExp(`^${term}(?:\\s|$|:)`, 'i');
      if (pattern.test(lowerLabel)) {
        return false;
      }
    }

    // PRIORITY 7: Special cases that are often standalone sections
    // Only match these if they appear as the primary label (at start)
    const standaloneTerms = ['introduction', 'conclusion'];
    for (const term of standaloneTerms) {
      // Only match if it's the entire label or starts the label
      const pattern = new RegExp(`^${term}(?:\\s|$|:)`, 'i');
      if (pattern.test(lowerLabel)) {
        // But if it's followed by "to" or "of", it's likely a chapter subsection
        if (!/^(introduction|conclusion)\s+(to|of|and)\s/i.test(lowerLabel)) {
          return false; // Standalone "Introduction" or "Conclusion"
        }
      }
    }

    // Default: number it (it's likely main content)
    return true;
  }

  private parseNcxDocument(ncxContent: string, spine: EpubSpineItem[]): TocItem[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(ncxContent, 'text/xml');

    let chapterCounter = 0;

    const parseNavPoint = (navPoint: Element, parentNumber = ''): TocItem | null => {
      const label = navPoint.querySelector('navLabel text')?.textContent?.trim() || 'Untitled';
      const fullHref = navPoint.querySelector('content')?.getAttribute('src') || '';

      // Split href into file and anchor parts
      const [file, anchorFragment] = fullHref.split('#');
      const spineIndex = this.findSpineIndex(file || fullHref, spine);

      // Determine if this item should be numbered
      // If parent is marked as NO_NUMBER, this child should also not be numbered
      const shouldNumber = parentNumber === 'NO_NUMBER'
        ? false
        : this.shouldNumberChapter(label);

      let chapterNumber: string | undefined;

      if (shouldNumber) {
        chapterCounter++;
        chapterNumber = parentNumber && parentNumber !== 'NO_NUMBER'
          ? `${parentNumber}.${chapterCounter}`
          : `${chapterCounter}`;
      }

      const item: TocItem = {
        label,
        href: file || fullHref,
        spineIndex,
        anchor: anchorFragment,
        chapterNumber
      };

      // Parse children
      const childNavPoints = Array.from(navPoint.children).filter(
        el => el.tagName.toLowerCase() === 'navpoint'
      );

      if (childNavPoints.length > 0) {
        item.children = childNavPoints
          .map(child => parseNavPoint(child, chapterNumber || (shouldNumber ? '' : 'NO_NUMBER')))
          .filter((child): child is TocItem => child !== null);
      }

      return item;
    };

    const navPoints = doc.querySelectorAll('navMap > navPoint');
    return Array.from(navPoints)
      .map(np => parseNavPoint(np, ''))
      .filter((item): item is TocItem => item !== null);
  }

  private createTocFromSpine(spine: EpubSpineItem[]): TocItem[] {
    return spine.map((item, index) => {
      // Try to create a meaningful label from the spine item
      let label = item.id;

      // Clean up common patterns in IDs
      label = label
        .replace(/^(chapter|ch|section|sec)[-_]?/i, '')
        .replace(/\.x?html?$/i, '')
        .replace(/[-_]/g, ' ')
        .trim();

      // Capitalize first letter
      if (label) {
        label = label.charAt(0).toUpperCase() + label.slice(1);
      }

      // If it's still not meaningful or is just a number, add context
      if (!label || /^\d+$/.test(label)) {
        label = `Section ${index + 1}`;
      }

      return {
        label,
        href: item.href,
        spineIndex: index,
        chapterNumber: `${index + 1}`
      };
    });
  }

  private findSpineIndex(href: string, spine: EpubSpineItem[]): number {
    // Remove anchor/fragment
    const cleanHref = href.split('#')[0];

    const index = spine.findIndex(item => {
      return item.href === cleanHref || item.href.endsWith('/' + cleanHref);
    });

    return index >= 0 ? index : 0;
  }
}


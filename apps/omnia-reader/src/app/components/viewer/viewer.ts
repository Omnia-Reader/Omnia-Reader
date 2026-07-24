import {
  Component,
  ElementRef,
  ViewChild,
  OnDestroy,
  ChangeDetectorRef,
  ViewEncapsulation,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  EpubParser,
  EpubMetadata,
  EpubSpineItem,
  TocItem,
} from './epub-parser';

interface ChapterContent {
  spineItem: EpubSpineItem;
  content: SafeHtml;
  index: number;
}

@Component({
  selector: 'omnia-viewer',
  imports: [],
  templateUrl: './viewer.html',
  styleUrl: './viewer.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
  encapsulation: ViewEncapsulation.ShadowDom,
})
export class Viewer implements OnDestroy {
  @ViewChild('contentContainer', { static: false })
  contentContainer!: ElementRef<HTMLDivElement>;

  parser: EpubParser | null = null;
  metadata: EpubMetadata | null = null;
  spine: EpubSpineItem[] = [];
  toc: TocItem[] = [];
  chapters: ChapterContent[] = [];
  epubStylesheets: string[] = [];

  // View settings
  fontSize = 18; // Base font size in pixels
  contentWidth = 100; // Content width as percentage of available space

  isTocOpen = true;
  isLoading = false;
  errorMessage: string | null = null;

  sanitizer: DomSanitizer = inject(DomSanitizer);
  cdr: ChangeDetectorRef = inject(ChangeDetectorRef);

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;

    this.isLoading = true;
    this.errorMessage = null;
    this.chapters = [];

    try {
      console.log('Loading EPUB file:', file.name);

      // Initialize parser
      this.parser = new EpubParser();
      await this.parser.loadFromFile(file);
      console.log('✅ EPUB file loaded into parser');

      // Get metadata
      this.metadata = await this.parser.getMetadata();
      console.log('✅ Metadata:', this.metadata);

      // Get spine (list of chapters)
      this.spine = await this.parser.getSpine();
      console.log('✅ Spine items:', this.spine.length);

      // Get table of contents
      this.toc = await this.parser.getTableOfContents(this.spine);
      console.log('✅ TOC items:', this.toc.length);
      console.log('TOC structure:', JSON.stringify(this.toc, null, 2));

      // Extract EPUB stylesheets
      this.epubStylesheets = await this.parser.extractStylesheets();
      console.log(
        '✅ EPUB stylesheets extracted:',
        this.epubStylesheets.length,
      );

      // Load all chapters for continuous scrolling
      await this.loadAllChapters();

      // Inject EPUB stylesheets into the shadow DOM
      this.injectEpubStyles();

      this.isLoading = false;
      this.cdr.detectChanges();
    } catch (err) {
      this.isLoading = false;
      this.errorMessage = `Failed to load EPUB: ${err instanceof Error ? err.message : 'Unknown error'}`;
      console.error('❌ Error loading EPUB:', err);
    }
  }

  async loadAllChapters() {
    console.log('Loading all chapters...');

    if (!this.parser) {
      console.error('Parser not initialized');
      return;
    }

    for (let i = 0; i < this.spine.length; i++) {
      try {
        const spineItem = this.spine[i];
        const content = await this.parser.getChapterContent(spineItem.href);
        const sanitizedContent =
          this.sanitizer.bypassSecurityTrustHtml(content);

        this.chapters.push({
          spineItem,
          content: sanitizedContent,
          index: i,
        });

        console.log(`✅ Loaded chapter ${i + 1}/${this.spine.length}`);
      } catch (err) {
        console.error(`Failed to load chapter ${i}:`, err);
      }
    }

    console.log('✅ All chapters loaded');
  }

  toggleToc() {
    this.isTocOpen = !this.isTocOpen;
  }

  navigateToChapter(tocItem: TocItem) {
    // In ShadowDOM, we can directly query from the contentContainer element
    if (!this.contentContainer) {
      console.error('Content container not available');
      return;
    }

    const chapterElement = this.contentContainer.nativeElement.querySelector(
      `#chapter-${tocItem.spineIndex}`,
    );

    if (!chapterElement) {
      console.warn(`Chapter element not found: chapter-${tocItem.spineIndex}`);
      return;
    }

    // If there's an anchor, try to find the specific element within the chapter
    if (tocItem.anchor) {
      const anchorElement = chapterElement.querySelector(
        `#${tocItem.anchor}, a[name="${tocItem.anchor}"]`,
      );

      if (anchorElement) {
        anchorElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        console.log(
          `Navigated to chapter ${tocItem.spineIndex}, anchor: ${tocItem.anchor}`,
        );
        return;
      } else {
        console.warn(
          `Anchor not found: ${tocItem.anchor}, scrolling to chapter instead`,
        );
      }
    }

    // Fallback: scroll to chapter start
    chapterElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    console.log(`Navigated to chapter ${tocItem.spineIndex}`);
  }

  // Font size controls
  increaseFontSize() {
    if (this.fontSize < 32) {
      this.fontSize += 2;
    }
  }

  decreaseFontSize() {
    if (this.fontSize > 12) {
      this.fontSize -= 2;
    }
  }

  resetFontSize() {
    this.fontSize = 18;
  }

  // Content width controls (percentage of available space)
  increaseWidth() {
    if (this.contentWidth < 100) {
      this.contentWidth += 10;
    }
  }

  decreaseWidth() {
    if (this.contentWidth > 50) {
      this.contentWidth -= 10;
    }
  }

  resetWidth() {
    this.contentWidth = 100;
  }

  get fontSizeStyle() {
    return `${this.fontSize}px`;
  }

  get contentWidthStyle() {
    return `${this.contentWidth}%`;
  }

  private injectEpubStyles() {
    if (this.epubStylesheets.length === 0) {
      console.log('No EPUB stylesheets to inject');
      return;
    }

    // Get the shadow root (available because we're using ViewEncapsulation.ShadowDom)
    const rootNode = this.contentContainer?.nativeElement?.getRootNode();

    // Check if we actually have a shadow root (not the document)
    if (!rootNode || rootNode.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      console.warn('Shadow DOM not available, cannot inject EPUB styles');
      return;
    }

    const shadowRoot = rootNode as ShadowRoot;

    // Create a style element for EPUB styles
    const styleElement = document.createElement('style');
    styleElement.id = 'epub-styles';

    // Combine all EPUB stylesheets and wrap to scope them to epub-content class
    styleElement.textContent = `
      /* EPUB Original Styles */
      .epub-content {
        ${this.epubStylesheets.join('\n\n')}
      }
    `;

    shadowRoot.appendChild(styleElement);

    console.log('✅ Injected EPUB styles into Shadow DOM');
  }

  ngOnDestroy() {
    // Clean up
    this.parser = null;
    this.chapters = [];
  }
}

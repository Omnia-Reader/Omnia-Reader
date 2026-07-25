import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { PublicationImportService } from './features/library/publication-import.service';

const BOOK_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

@Injectable({ providedIn: 'root' })
export class BookDeepLinkService {
  private readonly platform = inject(PLATFORM_PORT);
  private readonly repository = inject(LIBRARY_REPOSITORY);
  private readonly router = inject(Router);
  private readonly publicationImports = inject(PublicationImportService);

  start(): Promise<() => void> {
    return this.platform.onBookDeepLink((bookId) => this.openBook(bookId));
  }

  private async openBook(bookId: string): Promise<void> {
    try {
      if (!BOOK_ID_PATTERN.test(bookId)) {
        throw new Error('This Omnia Reader link is invalid');
      }
      const book = await this.repository.getBook(bookId);
      if (!book) {
        throw new Error(
          'This Omnia Reader link points to a publication that is not available in this local library. Sync or import the exact edition first.',
        );
      }
      this.publicationImports.clearError();
      await this.router.navigate(['/reader', book.id]);
    } catch (error) {
      this.publicationImports.reportError(error);
      await this.router.navigate(['/library']);
    }
  }
}

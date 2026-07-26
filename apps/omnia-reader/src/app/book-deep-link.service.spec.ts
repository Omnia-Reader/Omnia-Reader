import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LIBRARY_REPOSITORY } from '@omnia-reader/library/data-access';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { PlatformPort } from '@omnia-reader/reader/domain';
import type { Mock } from 'vitest';
import { BookDeepLinkService } from './book-deep-link.service';
import { PublicationImportService } from './features/library/publication-import.service';

const BOOK_ID = `sha256:${'a'.repeat(64)}`;

describe('BookDeepLinkService', () => {
  let deepLinkCallback: ((bookId: string) => void | Promise<void>) | null;
  let getBook: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let publicationImports: {
    clearError: ReturnType<typeof vi.fn>;
    reportError: ReturnType<typeof vi.fn>;
  };
  let stopPlatformListener: Mock<() => void>;
  let service: BookDeepLinkService;

  beforeEach(() => {
    deepLinkCallback = null;
    getBook = vi.fn();
    navigate = vi.fn().mockResolvedValue(true);
    publicationImports = {
      clearError: vi.fn(),
      reportError: vi.fn(),
    };
    stopPlatformListener = vi.fn();
    const platform: PlatformPort = {
      kind: 'tauri-desktop',
      supportsStreamingFileSave: true,
      getStorageStatus: vi.fn().mockResolvedValue({
        persistence: 'persistent',
      }),
      requestPersistentStorage: vi.fn().mockResolvedValue({
        persistence: 'persistent',
      }),
      pickPublications: vi.fn().mockResolvedValue([]),
      createFileSave: vi.fn().mockResolvedValue(null),
      onPublicationsOpened: vi.fn().mockResolvedValue(vi.fn()),
      onBookDeepLink: vi.fn(async (callback) => {
        deepLinkCallback = callback;
        return () => stopPlatformListener();
      }),
      onBackRequested: vi.fn().mockResolvedValue(vi.fn()),
      openExternalUrl: vi.fn().mockResolvedValue(undefined),
      requestApplicationExit: vi.fn().mockResolvedValue(undefined),
      onBackground: vi.fn(() => vi.fn()),
    };
    TestBed.configureTestingModule({
      providers: [
        BookDeepLinkService,
        { provide: PLATFORM_PORT, useValue: platform },
        { provide: LIBRARY_REPOSITORY, useValue: { getBook } },
        { provide: Router, useValue: { navigate } },
        { provide: PublicationImportService, useValue: publicationImports },
      ],
    });
    service = TestBed.inject(BookDeepLinkService);
  });

  it('opens an exact edition already present in the local library', async () => {
    getBook.mockResolvedValue({ id: BOOK_ID });
    const stop = await service.start();

    await openDeepLink(BOOK_ID);

    expect(getBook).toHaveBeenCalledWith(BOOK_ID);
    expect(publicationImports.clearError).toHaveBeenCalledOnce();
    expect(publicationImports.reportError).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/reader', BOOK_ID]);
    stop();
    expect(stopPlatformListener).toHaveBeenCalledOnce();
  });

  it('explains when the linked exact edition is not available locally', async () => {
    getBook.mockResolvedValue(null);
    await service.start();

    await openDeepLink(BOOK_ID);

    expect(publicationImports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('not available in this local library'),
      }),
    );
    expect(navigate).toHaveBeenCalledWith(['/library']);
  });

  it('rejects malformed book identities before querying local storage', async () => {
    await service.start();

    await openDeepLink('../not-a-book');

    expect(getBook).not.toHaveBeenCalled();
    expect(publicationImports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'This Omnia Reader link is invalid' }),
    );
    expect(navigate).toHaveBeenCalledWith(['/library']);
  });

  function openDeepLink(bookId: string): Promise<void> {
    if (!deepLinkCallback) {
      throw new Error(
        'Expected the platform deep-link listener to be registered',
      );
    }
    return Promise.resolve(deepLinkCallback(bookId));
  }
});

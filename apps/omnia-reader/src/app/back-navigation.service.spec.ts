import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { PLATFORM_PORT } from '@omnia-reader/platform';
import { PlatformPort } from '@omnia-reader/reader/domain';
import type { Mock } from 'vitest';
import {
  BackNavigationService,
  parentDestination,
} from './back-navigation.service';

describe('BackNavigationService', () => {
  let backRequested: (() => void | Promise<void>) | null;
  let stopPlatformListener: Mock<() => void>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let platform: PlatformPort;
  let router: Router;
  let service: BackNavigationService;

  beforeEach(() => {
    backRequested = null;
    stopPlatformListener = vi.fn();
    navigateByUrl = vi.fn().mockResolvedValue(true);
    platform = {
      kind: 'tauri-android',
      supportsStreamingFileSave: true,
      pickPublications: vi.fn().mockResolvedValue([]),
      createFileSave: vi.fn().mockResolvedValue(null),
      onPublicationsOpened: vi.fn().mockResolvedValue(vi.fn()),
      onBookDeepLink: vi.fn().mockResolvedValue(vi.fn()),
      onBackRequested: vi.fn(async (callback) => {
        backRequested = callback;
        return () => stopPlatformListener();
      }),
      openExternalUrl: vi.fn().mockResolvedValue(undefined),
      requestApplicationExit: vi.fn().mockResolvedValue(undefined),
      onBackground: vi.fn(() => vi.fn()),
    };
    router = {
      url: '/library',
      navigateByUrl,
    } as unknown as Router;
    TestBed.configureTestingModule({
      providers: [
        BackNavigationService,
        { provide: PLATFORM_PORT, useValue: platform },
        { provide: Router, useValue: router },
        { provide: DOCUMENT, useValue: document },
      ],
    });
    service = TestBed.inject(BackNavigationService);
  });

  it('consumes transient handlers in last-registered-first order on Escape', async () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = service.registerTransientHandler(first);
    const unregisterSecond = service.registerTransientHandler(second);
    const stop = await service.start();

    const firstEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    });
    document.dispatchEvent(firstEscape);

    expect(firstEscape.defaultPrevented).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();

    unregisterSecond();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(first).toHaveBeenCalledOnce();

    unregisterFirst();
    stop();
    expect(stopPlatformListener).toHaveBeenCalledOnce();
  });

  it('closes transient UI before navigating Android back to a parent route', async () => {
    const transientHandler = vi.fn(() => true);
    const unregister = service.registerTransientHandler(transientHandler);
    await service.start();

    await requestBack();
    expect(transientHandler).toHaveBeenCalledOnce();
    expect(navigateByUrl).not.toHaveBeenCalled();

    unregister();
    Reflect.set(router, 'url', '/reader/sha256:book?from=library');
    await requestBack();

    await vi.waitFor(() =>
      expect(navigateByUrl).toHaveBeenCalledWith('/library', {
        replaceUrl: true,
      }),
    );
    expect(platform.requestApplicationExit).not.toHaveBeenCalled();
  });

  it('exits the Android application only from the library root', async () => {
    await service.start();
    await requestBack();

    await vi.waitFor(() =>
      expect(platform.requestApplicationExit).toHaveBeenCalledOnce(),
    );
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  function requestBack(): Promise<void> {
    if (!backRequested) {
      throw new Error('Expected the platform back listener to be registered');
    }
    return Promise.resolve(backRequested());
  }
});

describe('parentDestination', () => {
  it.each([
    ['/reader/sha256:book', '/library'],
    ['/reader/sha256:book?from=library', '/library'],
    ['/settings/sync', '/settings'],
    ['/settings', '/library'],
    ['/library', null],
    ['/unknown', '/library'],
  ])('maps %s to %s', (url, expected) => {
    expect(parentDestination(url)).toBe(expected);
  });
});

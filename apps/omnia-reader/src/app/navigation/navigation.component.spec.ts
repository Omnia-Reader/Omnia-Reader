import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  AUTO_SYNC_SCHEDULER,
  AutoSyncStatus,
  SYNC_PROVIDER_SELECTION,
} from '@omnia-reader/sync/core';

import { BackNavigationService } from '../back-navigation.service';
import { NavigationComponent } from './navigation.component';

describe('NavigationComponent', () => {
  let component: NavigationComponent;
  let fixture: ComponentFixture<NavigationComponent>;
  let transientHandler: (() => boolean) | null;
  let unregisterTransientHandler: ReturnType<typeof vi.fn>;
  let syncStatusListener: ((status: AutoSyncStatus) => void) | null;
  let unregisterSyncStatus: ReturnType<typeof vi.fn>;
  let syncProviderListener: (() => void) | null;
  let unregisterSyncProvider: ReturnType<typeof vi.fn>;
  let selectedProvider: 'git' | 'mega' | null;

  beforeEach(async () => {
    transientHandler = null;
    unregisterTransientHandler = vi.fn();
    syncStatusListener = null;
    unregisterSyncStatus = vi.fn();
    syncProviderListener = null;
    unregisterSyncProvider = vi.fn();
    selectedProvider = 'git';
    await TestBed.configureTestingModule({
      imports: [NavigationComponent],
      providers: [
        provideRouter([]),
        {
          provide: BackNavigationService,
          useValue: {
            registerTransientHandler: vi.fn((handler: () => boolean) => {
              transientHandler = handler;
              return unregisterTransientHandler;
            }),
          },
        },
        {
          provide: AUTO_SYNC_SCHEDULER,
          useValue: {
            status: () => ({ phase: 'idle' }),
            subscribe: vi.fn((listener: (status: AutoSyncStatus) => void) => {
              syncStatusListener = listener;
              listener({ phase: 'idle' });
              return unregisterSyncStatus;
            }),
          },
        },
        {
          provide: SYNC_PROVIDER_SELECTION,
          useValue: {
            current: () => selectedProvider,
            subscribe: vi.fn((listener: () => void) => {
              syncProviderListener = listener;
              listener();
              return unregisterSyncProvider;
            }),
          },
        },
      ],
    }).compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(NavigationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the primary library and settings navigation', () => {
    expect(component).toBeTruthy();
    const links = Array.from(
      fixture.nativeElement.querySelectorAll(
        'a',
      ) as NodeListOf<HTMLAnchorElement>,
      (link) => link.textContent?.trim(),
    );

    expect(links.some((link) => link?.includes('Library'))).toBe(true);
    expect(links.some((link) => link?.includes('Settings'))).toBe(true);
  });

  it('opens and closes the mobile navigation', () => {
    const openButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      'button[aria-controls="primary-navigation"]',
    );

    openButton.click();
    fixture.detectChanges();

    expect(component.menuOpen).toBe(true);
    expect(openButton.getAttribute('aria-expanded')).toBe('true');
    const closeButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      'button[aria-label="Close navigation"]',
    );
    expect(closeButton).toBeTruthy();

    closeButton.click();
    fixture.detectChanges();

    expect(component.menuOpen).toBe(false);
    expect(
      fixture.nativeElement
        .querySelector('button[aria-controls="primary-navigation"]')
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(unregisterTransientHandler).toHaveBeenCalledOnce();
  });

  it('registers the open mobile navigation as transient back UI', () => {
    component.toggleMenu();

    if (!transientHandler) {
      throw new Error('Expected a transient navigation handler');
    }
    expect(transientHandler()).toBe(true);
    fixture.detectChanges();

    expect(component.menuOpen).toBe(false);
    expect(unregisterTransientHandler).toHaveBeenCalledOnce();
  });

  it('keeps synchronization status visible and links directly to its settings', () => {
    const statusLink: HTMLAnchorElement = fixture.nativeElement.querySelector(
      '[data-testid="global-sync-status"]',
    );

    expect(statusLink.getAttribute('href')).toBe('/settings/sync');
    expect(statusLink.textContent).toContain('Sync ready');
    expect(statusLink.getAttribute('title')).toContain('Git + LFS');
  });

  it('reports live transfer progress and actionable failures globally', () => {
    if (!syncStatusListener) {
      throw new Error('Expected the synchronization status subscription');
    }

    syncStatusListener({
      phase: 'syncing',
      transferProgress: {
        direction: 'upload',
        path: 'books/example/book.epub',
        transferredBytes: 50,
        totalBytes: 200,
      },
    });
    fixture.detectChanges();

    const statusLink: HTMLAnchorElement = fixture.nativeElement.querySelector(
      '[data-testid="global-sync-status"]',
    );
    expect(statusLink.textContent).toContain('Syncing 25%');
    expect(statusLink.getAttribute('aria-label')).toBe(
      'Syncing 25%. View sync details.',
    );

    syncStatusListener({
      phase: 'error',
      errorMessage: 'Reconnect GitHub to continue synchronization.',
    });
    fixture.detectChanges();

    expect(statusLink.textContent).toContain('Sync needs attention');
    expect(statusLink.getAttribute('title')).toBe(
      'Reconnect GitHub to continue synchronization.',
    );
  });

  it('guides users to configure synchronization and releases its listener', () => {
    selectedProvider = null;
    syncProviderListener?.();
    fixture.detectChanges();

    const statusLink: HTMLAnchorElement = fixture.nativeElement.querySelector(
      '[data-testid="global-sync-status"]',
    );
    expect(statusLink.textContent).toContain('Set up sync');
    expect(statusLink.getAttribute('title')).toContain(
      'Set up Git synchronization',
    );

    fixture.destroy();
    expect(unregisterSyncStatus).toHaveBeenCalledOnce();
    expect(unregisterSyncProvider).toHaveBeenCalledOnce();
  });
});

describe('NavigationComponent in a local-only build', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NavigationComponent],
      providers: [
        provideRouter([]),
        {
          provide: BackNavigationService,
          useValue: {
            registerTransientHandler: () => () => undefined,
          },
        },
      ],
    }).compileComponents();
  });

  it('explains that the library stays local without exposing a sync route', () => {
    const fixture = TestBed.createComponent(NavigationComponent);
    fixture.detectChanges();

    const statusLink: HTMLAnchorElement = fixture.nativeElement.querySelector(
      '[data-testid="global-sync-status"]',
    );
    expect(statusLink.textContent).toContain('Local only');
    expect(statusLink.getAttribute('href')).toBe('/settings');
    expect(statusLink.getAttribute('title')).toContain(
      'keeps books and reading activity on this device',
    );
  });
});

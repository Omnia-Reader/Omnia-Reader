import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { BackNavigationService } from '../back-navigation.service';
import { NavigationComponent } from './navigation.component';

describe('NavigationComponent', () => {
  let component: NavigationComponent;
  let fixture: ComponentFixture<NavigationComponent>;
  let transientHandler: (() => boolean) | null;
  let unregisterTransientHandler: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    transientHandler = null;
    unregisterTransientHandler = vi.fn();
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
});

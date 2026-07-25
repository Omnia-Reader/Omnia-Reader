import {
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  inject,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { BackNavigationService } from '../back-navigation.service';

@Component({
  selector: 'omnia-navigation',
  templateUrl: './navigation.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
})
export class NavigationComponent implements OnDestroy {
  private readonly backNavigation = inject(BackNavigationService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private removeMenuBackHandler: (() => void) | null = null;

  menuOpen = false;

  toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
      return;
    }

    this.menuOpen = true;
    this.removeMenuBackHandler = this.backNavigation.registerTransientHandler(
      () => {
        if (!this.menuOpen) {
          return false;
        }
        this.closeMenu();
        return true;
      },
    );
  }

  closeMenu(): void {
    if (!this.menuOpen && !this.removeMenuBackHandler) {
      return;
    }
    this.menuOpen = false;
    this.removeMenuBackHandler?.();
    this.removeMenuBackHandler = null;
    this.changeDetector.markForCheck();
  }

  ngOnDestroy(): void {
    this.closeMenu();
  }
}

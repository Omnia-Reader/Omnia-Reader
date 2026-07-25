import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PLATFORM_PORT } from '@omnia-reader/platform';

export type TransientBackHandler = () => boolean;

@Injectable({ providedIn: 'root' })
export class BackNavigationService {
  private readonly platform = inject(PLATFORM_PORT);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly transientHandlers: TransientBackHandler[] = [];
  private handlingPlatformBack = false;

  registerTransientHandler(handler: TransientBackHandler): () => void {
    this.transientHandlers.push(handler);
    let registered = true;
    return () => {
      if (!registered) {
        return;
      }
      registered = false;
      const index = this.transientHandlers.lastIndexOf(handler);
      if (index >= 0) {
        this.transientHandlers.splice(index, 1);
      }
    };
  }

  async start(): Promise<() => void> {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.consumeTransientHandler()) {
        event.preventDefault();
      }
    };
    this.document.addEventListener('keydown', onEscape);

    try {
      const stopPlatformListener = await this.platform.onBackRequested(() => {
        void this.handlePlatformBack();
      });
      let stopped = false;
      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        this.document.removeEventListener('keydown', onEscape);
        stopPlatformListener();
      };
    } catch (error) {
      this.document.removeEventListener('keydown', onEscape);
      throw error;
    }
  }

  private consumeTransientHandler(): boolean {
    for (let index = this.transientHandlers.length - 1; index >= 0; index--) {
      if (this.transientHandlers[index]()) {
        return true;
      }
    }
    return false;
  }

  private async handlePlatformBack(): Promise<void> {
    if (this.handlingPlatformBack) {
      return;
    }
    this.handlingPlatformBack = true;
    try {
      if (this.consumeTransientHandler()) {
        return;
      }

      const destination = parentDestination(this.router.url);
      if (destination) {
        await this.router.navigateByUrl(destination, { replaceUrl: true });
      } else {
        await this.platform.requestApplicationExit();
      }
    } finally {
      this.handlingPlatformBack = false;
    }
  }
}

export function parentDestination(url: string): string | null {
  const [path] = url.split(/[?#]/, 1);
  if (path.startsWith('/reader/')) {
    return '/library';
  }
  if (path === '/settings/sync') {
    return '/settings';
  }
  if (path === '/settings') {
    return '/library';
  }
  if (path === '/library') {
    return null;
  }
  return '/library';
}

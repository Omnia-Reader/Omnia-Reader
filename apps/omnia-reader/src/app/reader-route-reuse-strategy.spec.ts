import {
  ActivatedRouteSnapshot,
  convertToParamMap,
  Route,
} from '@angular/router';
import { ReaderRouteReuseStrategy } from './reader-route-reuse-strategy';

describe('ReaderRouteReuseStrategy', () => {
  const readerRoute: Route = { path: 'reader/:bookId' };
  const libraryRoute: Route = { path: 'library' };
  const strategy = new ReaderRouteReuseStrategy();

  it('recreates the reader when navigation selects another publication', () => {
    expect(
      strategy.shouldReuseRoute(
        snapshot(readerRoute, 'second-book'),
        snapshot(readerRoute, 'first-book'),
      ),
    ).toBe(false);
  });

  it('reuses the current reader for navigation to the same publication', () => {
    expect(
      strategy.shouldReuseRoute(
        snapshot(readerRoute, 'same-book'),
        snapshot(readerRoute, 'same-book'),
      ),
    ).toBe(true);
  });

  it('preserves Angular reuse behavior for non-reader routes', () => {
    expect(
      strategy.shouldReuseRoute(snapshot(libraryRoute), snapshot(libraryRoute)),
    ).toBe(true);
    expect(
      strategy.shouldReuseRoute(
        snapshot(readerRoute, 'book'),
        snapshot(libraryRoute),
      ),
    ).toBe(false);
  });
});

function snapshot(routeConfig: Route, bookId?: string): ActivatedRouteSnapshot {
  return {
    routeConfig,
    paramMap: convertToParamMap(bookId ? { bookId } : {}),
  } as ActivatedRouteSnapshot;
}

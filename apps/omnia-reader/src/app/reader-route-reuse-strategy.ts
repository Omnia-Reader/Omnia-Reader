import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  BaseRouteReuseStrategy,
} from '@angular/router';

@Injectable()
export class ReaderRouteReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    current: ActivatedRouteSnapshot,
  ): boolean {
    if (!super.shouldReuseRoute(future, current)) {
      return false;
    }
    if (future.routeConfig?.path !== 'reader/:bookId') {
      return true;
    }
    return future.paramMap.get('bookId') === current.paramMap.get('bookId');
  }
}

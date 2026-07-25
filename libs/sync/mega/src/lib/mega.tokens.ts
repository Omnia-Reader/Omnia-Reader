import { InjectionToken } from '@angular/core';
import { MegaGateway } from './mega-gateway-client';

export const MEGA_GATEWAY = new InjectionToken<MegaGateway>('MEGA_GATEWAY');

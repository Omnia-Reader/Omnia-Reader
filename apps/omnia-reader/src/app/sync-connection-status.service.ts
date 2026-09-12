import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  SYNC_PROVIDER_SELECTION,
  SyncProviderKind,
  SyncProviderMaturity,
  syncProviderPresentation,
} from '@omnia-reader/sync/core';
import {
  GITHUB_GATEWAY,
  GitHubGateway,
  GitHubGatewayError,
} from '@omnia-reader/sync/git';
import {
  MEGA_GATEWAY,
  MegaGateway,
  MegaGatewayError,
} from '@omnia-reader/sync/mega';

export type SyncConnectionState =
  | 'local-only'
  | 'checking'
  | 'gateway-unavailable'
  | 'provider-unconfigured'
  | 'authorization-required'
  | 'destination-required'
  | 'ready';

export interface SyncConnectionSnapshot {
  state: SyncConnectionState;
  provider: SyncProviderKind | null;
  providerLabel?: string;
  providerMaturity?: SyncProviderMaturity;
  providerMaturityLabel?: 'Experimental' | 'Supported';
  providerMaturityConsequence?: string;
  accountLabel?: string;
  destinationLabel?: string;
}

@Injectable({ providedIn: 'root' })
export class SyncConnectionStatusService {
  private readonly selection = inject(SYNC_PROVIDER_SELECTION, {
    optional: true,
  });
  private readonly git = inject(GITHUB_GATEWAY, { optional: true });
  private readonly mega = inject(MEGA_GATEWAY, { optional: true });
  private refreshGeneration = 0;
  private activeRefresh: {
    provider: SyncProviderKind | null;
    promise: Promise<SyncConnectionSnapshot>;
  } | null = null;

  readonly snapshot = signal<SyncConnectionSnapshot>({
    state: 'checking',
    provider: this.selection?.current() ?? null,
  });

  constructor() {
    const unsubscribe = this.selection?.subscribe?.(() => {
      void this.refresh();
    });
    if (unsubscribe) {
      inject(DestroyRef).onDestroy(unsubscribe);
    }
  }

  refresh(force = false): Promise<SyncConnectionSnapshot> {
    const provider = this.selection?.current() ?? null;
    if (!force && this.activeRefresh?.provider === provider) {
      return this.activeRefresh.promise;
    }
    const generation = ++this.refreshGeneration;
    const promise = this.inspect(provider, generation).finally(() => {
      if (this.activeRefresh?.promise === promise) {
        this.activeRefresh = null;
      }
    });
    this.activeRefresh = { provider, promise };
    return promise;
  }

  private async inspect(
    provider: SyncProviderKind | null,
    generation: number,
  ): Promise<SyncConnectionSnapshot> {
    if (!provider) {
      return this.publish(generation, { state: 'local-only', provider: null });
    }

    this.publish(generation, {
      state: 'checking',
      provider,
      ...providerDetails(provider),
    });
    try {
      const next =
        provider === 'git'
          ? await inspectGit(this.git, provider)
          : await inspectMega(this.mega, provider);
      return this.publish(generation, next);
    } catch (error) {
      const state = isProviderUnconfigured(error)
        ? 'provider-unconfigured'
        : 'gateway-unavailable';
      return this.publish(generation, {
        state,
        provider,
        ...providerDetails(provider),
      });
    }
  }

  private publish(
    generation: number,
    snapshot: SyncConnectionSnapshot,
  ): SyncConnectionSnapshot {
    if (generation === this.refreshGeneration) {
      this.snapshot.set(snapshot);
      return snapshot;
    }
    return this.snapshot();
  }
}

async function inspectGit(
  gateway: GitHubGateway | null,
  provider: 'git',
): Promise<SyncConnectionSnapshot> {
  if (!gateway) {
    return {
      state: 'gateway-unavailable',
      provider,
      ...providerDetails(provider),
    };
  }
  const session = await gateway.session();
  if (!session.configured) {
    return {
      state: 'provider-unconfigured',
      provider,
      ...providerDetails(provider),
    };
  }
  if (!session.authenticated) {
    return {
      state: 'authorization-required',
      provider,
      ...providerDetails(provider),
    };
  }
  if (!session.repository) {
    await gateway.repositories();
    return {
      state: 'destination-required',
      provider,
      ...providerDetails(provider),
      accountLabel: session.user.login,
    };
  }
  return {
    state: 'ready',
    provider,
    ...providerDetails(provider),
    accountLabel: session.user.login,
    destinationLabel: session.repository.fullName,
  };
}

async function inspectMega(
  gateway: MegaGateway | null,
  provider: 'mega',
): Promise<SyncConnectionSnapshot> {
  if (!gateway) {
    return {
      state: 'gateway-unavailable',
      provider,
      ...providerDetails(provider),
    };
  }
  const session = await gateway.session();
  if (!session.authenticated) {
    return {
      state: 'authorization-required',
      provider,
      ...providerDetails(provider),
    };
  }
  if (!session.folder) {
    return {
      state: 'destination-required',
      provider,
      ...providerDetails(provider),
      accountLabel: session.account,
    };
  }
  return {
    state: 'ready',
    provider,
    ...providerDetails(provider),
    accountLabel: session.account,
    destinationLabel: session.folder.path,
  };
}

function isProviderUnconfigured(error: unknown): boolean {
  return (
    (error instanceof GitHubGatewayError ||
      error instanceof MegaGatewayError) &&
    (error.status === 404 ||
      (error.status === 503 && error.message.includes('not configured')))
  );
}

function providerDetails(
  provider: SyncProviderKind,
): Pick<
  SyncConnectionSnapshot,
  | 'providerLabel'
  | 'providerMaturity'
  | 'providerMaturityLabel'
  | 'providerMaturityConsequence'
> {
  const presentation = syncProviderPresentation(provider);
  return {
    providerLabel: provider === 'git' ? 'GitHub' : presentation.name,
    providerMaturity: presentation.maturity,
    providerMaturityLabel: presentation.maturityLabel,
    providerMaturityConsequence: presentation.consequence,
  };
}

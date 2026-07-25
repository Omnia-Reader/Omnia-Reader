import type {
  DocumentWriteRequest,
  RemoteDocument,
  RemoteObject,
  RemoteObjectDownload,
  RemoteObjectUpload,
  SyncGatewayAdapter,
} from './gateway-contract.js';
import { GatewayHttpError } from './gateway-contract.js';

export class UnconfiguredSyncGatewayAdapter implements SyncGatewayAdapter {
  constructor(private readonly providerLabel: string) {}

  async session(): Promise<unknown> {
    return { authenticated: false };
  }

  async authorizationUrl(): Promise<string> {
    return this.unavailable();
  }

  async completeAuthorization(): Promise<string> {
    return this.unavailable();
  }

  async disconnect(sessionId: string): Promise<void> {
    void sessionId;
  }

  async destinations(): Promise<readonly unknown[]> {
    return this.unavailable();
  }

  async selectDestination(): Promise<unknown> {
    return this.unavailable();
  }

  async listDocuments(): Promise<readonly RemoteDocument[]> {
    return this.unavailable();
  }

  async readDocument(): Promise<RemoteDocument | null> {
    return this.unavailable();
  }

  async writeDocument(
    sessionId: string,
    request: DocumentWriteRequest,
  ): Promise<RemoteDocument> {
    void sessionId;
    void request;
    return this.unavailable();
  }

  async headObject(): Promise<RemoteObject | null> {
    return this.unavailable();
  }

  async downloadObject(): Promise<RemoteObjectDownload | null> {
    return this.unavailable();
  }

  async uploadObject(
    sessionId: string,
    upload: RemoteObjectUpload,
  ): Promise<RemoteObject> {
    void sessionId;
    void upload;
    return this.unavailable();
  }

  private unavailable(): never {
    throw new GatewayHttpError(
      404,
      `${this.providerLabel} synchronization is not configured`,
    );
  }
}

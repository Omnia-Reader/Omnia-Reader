import { PublicationFormat, ReaderEngine } from '@omnia-reader/reader/domain';

export type ReaderEngineLoader = () => Promise<ReaderEngine>;

export class ReaderEngineRegistry {
  private readonly loaders = new Map<PublicationFormat, ReaderEngineLoader>();

  register(format: PublicationFormat, loader: ReaderEngineLoader): void {
    this.loaders.set(format, loader);
  }

  supports(format: PublicationFormat): boolean {
    return this.loaders.has(format);
  }

  async create(format: PublicationFormat): Promise<ReaderEngine> {
    const loader = this.loaders.get(format);

    if (!loader) {
      throw new Error(`No reader engine is registered for "${format}"`);
    }

    return loader();
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProviderConfigurations } from '@bookorbit/types';

export const metadataOperationScope = new AsyncLocalStorage<{
  accountId: number | null;
  externalAuthorization: ReadonlyMap<number, { baseUrl: string; authorization: string }>;
  config: ProviderConfigurations;
  cachePartition: string;
}>();

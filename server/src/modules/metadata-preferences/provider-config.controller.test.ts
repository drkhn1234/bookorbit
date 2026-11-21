import type { RequestUser } from '../../common/types/request-user';
import { BadRequestException } from '@nestjs/common';
import { MetadataProviderKey } from '@bookorbit/types';
import { ProviderConfigController } from './provider-config.controller';
import type { Mocked } from 'vitest';
import { ProviderConfigService } from './provider-config.service';

describe('ProviderConfigController', () => {
  let service: Mocked<ProviderConfigService>;
  let controller: ProviderConfigController;
  const user = { id: 7, permissions: [] } as unknown as RequestUser;

  beforeEach(() => {
    service = {
      getSettingsView: vi.fn(),
      runForAccount: vi.fn((_id, run) => Promise.resolve(run())),
      updateConfig: vi.fn(),
      testProvider: vi.fn(),
    } as unknown as Mocked<ProviderConfigService>;

    controller = new ProviderConfigController(service);
  });

  it('returns both provider config and computed statuses', async () => {
    const config = {
      google: { enabled: true, apiKey: '' },
      amazon: { enabled: true, domain: 'amazon.com', cookie: '' },
      goodreads: { enabled: true },
      hardcover: { enabled: false, apiKey: '' },
      openLibrary: { enabled: true },
    };
    const statuses = [{ key: 'google', enabled: true, configured: true, label: 'Google Books' }];

    service.getSettingsView.mockResolvedValue({ config, statuses } as never);
    const result = await controller.getConfig(user);
    expect(service.getSettingsView).toHaveBeenCalledWith(7);
    expect(result).toEqual({ config, statuses });
  });

  it('delegates config updates', async () => {
    const patch = {
      google: { enabled: false },
      amazon: { cookie: 'session' },
    };
    service.updateConfig.mockResolvedValue({} as never);

    await controller.updateConfig(patch as never, user);

    expect(service.updateConfig).toHaveBeenCalledWith(patch, 7);
  });

  it('delegates provider test requests', async () => {
    const patch = {
      hardcover: { apiKey: 'Bearer token' },
    };
    const result = { key: MetadataProviderKey.HARDCOVER, ok: true, status: 'success', message: 'Connected as reader.' };
    service.testProvider.mockResolvedValue(result as never);

    await expect(controller.testProvider('hardcover', patch as never, user)).resolves.toEqual(result);
    expect(service.testProvider).toHaveBeenCalledWith(MetadataProviderKey.HARDCOVER, patch);
  });

  it('rejects unknown provider keys for test requests', async () => {
    await expect(controller.testProvider('unknown-provider', {} as never, user)).rejects.toThrow(BadRequestException);
    expect(service.testProvider).not.toHaveBeenCalled();
  });
});

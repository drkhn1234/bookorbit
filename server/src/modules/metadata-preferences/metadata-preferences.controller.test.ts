import type { RequestUser } from '../../common/types/request-user';
import type { Mocked } from 'vitest';
import { MetadataProviderKey } from '@bookorbit/types';

import { MetadataPreferencesController } from './metadata-preferences.controller';
import { MetadataPreferencesService } from './metadata-preferences.service';

describe('MetadataPreferencesController', () => {
  let service: Mocked<MetadataPreferencesService>;
  let controller: MetadataPreferencesController;
  const user = { id: 7, permissions: [] } as unknown as RequestUser;

  beforeEach(() => {
    service = {
      getDefaults: vi.fn(),
      setDefaults: vi.fn(),
      resetDefaults: vi.fn(),
      getForLibrary: vi.fn(),
      setLibraryOverrides: vi.fn(),
      resetLibraryToGlobal: vi.fn(),
    } as unknown as Mocked<MetadataPreferencesService>;

    controller = new MetadataPreferencesController(service, { assertLevel: vi.fn() } as never);
  });

  it('returns global preferences from service', async () => {
    service.getDefaults.mockResolvedValue({ fields: {} } as never);

    const result = await controller.getGlobal(user);

    expect(service.getDefaults).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ fields: {} });
  });

  it('delegates global updates', async () => {
    const dto = {
      fields: {
        title: {
          enabled: true,
          providers: [MetadataProviderKey.GOOGLE],
          mergeStrategy: 'fillMissing',
        },
      },
    };

    await controller.setGlobal(dto as never, user);

    expect(service.setDefaults).toHaveBeenCalledWith(7, dto);
  });

  it('delegates global reset to service', async () => {
    await controller.resetGlobal(user);

    expect(service.resetDefaults).toHaveBeenCalledTimes(1);
  });

  it('returns library-specific effective preferences', async () => {
    service.getForLibrary.mockResolvedValue({ libraryId: 1, overrides: null, effective: { fields: {} } } as never);

    const result = await controller.getForLibrary(1, user);

    expect(service.getForLibrary).toHaveBeenCalledWith(1);
    expect(result.libraryId).toBe(1);
  });

  it('writes bulk library overrides', async () => {
    const dto = {
      overrides: {
        title: {
          enabled: true,
          providers: [MetadataProviderKey.OPEN_LIBRARY],
          mergeStrategy: 'overwriteIfProvided',
        },
      },
    };

    await controller.setLibraryOverrides(2, dto as never, user);

    expect(service.setLibraryOverrides).toHaveBeenCalledWith(2, dto.overrides);
  });

  it('delegates library reset to service', async () => {
    await controller.resetLibraryToGlobal(8, user);

    expect(service.resetLibraryToGlobal).toHaveBeenCalledWith(8);
  });
});

import { PathController } from './path.controller';
import { TEST_ADMIN_REQUEST } from '../../../test/unit/path-access';
import { Permission } from '@bookorbit/types';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { KEY_READ_SAFE_KEY } from '../../common/decorators/api-key-policy.decorator';

const user = TEST_ADMIN_REQUEST.user;
const request = { user, scope: undefined };

describe('PathController', () => {
  const pathService = {
    getConfig: vi.fn(),
    listDirectories: vi.fn(),
    createDirectory: vi.fn(),
    listFolder: vi.fn(),
    searchFolders: vi.fn(),
    getPlaces: vi.fn(),
    adoptPersonalRoot: vi.fn(),
  };
  const folderInsight = {
    summarize: vi.fn(),
    inspect: vi.fn(),
    unclaimed: vi.fn(),
    forget: vi.fn(),
  };

  const controller = new PathController(pathService as never, folderInsight as never);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('keeps ordinary storage endpoints independent of global ManageLibraries while protecting adoption', () => {
    for (const method of [
      'getConfig',
      'listDirectories',
      'listFolder',
      'summarize',
      'inspect',
      'search',
      'places',
      'unclaimed',
      'createFolder',
    ] as const) {
      expect(Reflect.getMetadata(PERMISSION_KEY, PathController.prototype[method])).toBeUndefined();
    }
    expect(Reflect.getMetadata(PERMISSION_KEY, PathController.prototype.adoptPersonalRoot)).toBe(Permission.ManageLibraries);
    expect(Reflect.getMetadata(KEY_READ_SAFE_KEY, PathController.prototype.summarize)).toBe(true);
  });

  it('returns personal path config from the service', async () => {
    pathService.getConfig.mockResolvedValue({ root: '/books/operator' });

    await expect(controller.getConfig(user, {})).resolves.toEqual({ root: '/books/operator' });
    expect(pathService.getConfig).toHaveBeenCalledWith(request);
  });

  it('lets the service apply the default path when query path is missing', async () => {
    await controller.listDirectories(user, {});

    expect(pathService.listDirectories).toHaveBeenCalledWith(request, undefined);
  });

  it('passes provided query path through to the service', async () => {
    await controller.listDirectories(user, { path: '/books' });

    expect(pathService.listDirectories).toHaveBeenCalledWith(request, '/books');
  });

  it('forwards folder creation to the service and drops cached folder counts', async () => {
    pathService.createDirectory.mockResolvedValue({ name: 'scifi', path: '/books/scifi' });

    await expect(controller.createFolder(user, { parentPath: '/books', name: 'scifi' }, {})).resolves.toEqual({
      name: 'scifi',
      path: '/books/scifi',
    });

    expect(pathService.createDirectory).toHaveBeenCalledWith(request, '/books', 'scifi');
    expect(folderInsight.forget).toHaveBeenCalledTimes(1);
  });

  it('keeps cached counts when folder creation fails', async () => {
    pathService.createDirectory.mockRejectedValue(new Error('exists'));

    await expect(controller.createFolder(user, { parentPath: '/books', name: 'scifi' }, {})).rejects.toThrow('exists');

    expect(folderInsight.forget).not.toHaveBeenCalled();
  });

  it('passes the listing path through to the service', async () => {
    await controller.listFolder(user, { path: '/books' });

    expect(pathService.listFolder).toHaveBeenCalledWith(request, '/books');
  });

  it('summarizes the requested paths in one batch', async () => {
    await controller.summarize(user, { paths: ['/books/a', '/books/b'] }, {});

    expect(folderInsight.summarize).toHaveBeenCalledWith(request, ['/books/a', '/books/b']);
  });

  it('inspects the browse root when no path is given', async () => {
    await controller.inspect(user, {});

    expect(folderInsight.inspect).toHaveBeenCalledWith(request, '');
  });

  it('searches system folders only when asked', async () => {
    await controller.search(user, { q: 'wells', path: '/books' });
    await controller.search(user, { q: 'usr', system: 'true', scope: 'admin' });

    expect(pathService.searchFolders).toHaveBeenNthCalledWith(1, request, 'wells', '/books', false);
    expect(pathService.searchFolders).toHaveBeenNthCalledWith(2, { user, scope: 'admin' }, 'usr', undefined, true);
  });

  it('returns places and unclaimed folders from their services', async () => {
    pathService.getPlaces.mockResolvedValue({ root: '/', mounts: ['/books'], appDataPath: '/data', libraries: [] });
    folderInsight.unclaimed.mockResolvedValue({ folders: [], truncated: false });

    await expect(controller.places(user, {})).resolves.toEqual({ root: '/', mounts: ['/books'], appDataPath: '/data', libraries: [] });
    await expect(controller.unclaimed(user, {})).resolves.toEqual({ folders: [], truncated: false });
    expect(pathService.getPlaces).toHaveBeenCalledWith(request);
    expect(folderInsight.unclaimed).toHaveBeenCalledWith(request);
  });

  it('exposes adoption only as a deliberate operation with a stored target user ID', async () => {
    pathService.adoptPersonalRoot.mockResolvedValue('/books/alice');
    await expect(controller.adoptPersonalRoot(user, { userId: 2 })).resolves.toEqual({ root: '/books/alice' });
    expect(pathService.adoptPersonalRoot).toHaveBeenCalledWith(user, 2);
    expect(folderInsight.forget).toHaveBeenCalledOnce();
  });
});

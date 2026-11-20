import 'reflect-metadata';

vi.mock('../../book/book.module', () => ({ BookModule: class BookModule {} }));
vi.mock('../../library/library.module', () => ({ LibraryModule: class LibraryModule {} }));

import { BookModule } from '../../book/book.module';
import { EpubController } from './epub.controller';
import { EpubModule } from './epub.module';
import { EpubService } from './epub.service';

describe('EpubModule', () => {
  it('registers expected imports/controllers/providers', () => {
    expect(Reflect.getMetadata('imports', EpubModule)).toEqual([BookModule]);
    expect(Reflect.getMetadata('controllers', EpubModule)).toEqual([EpubController]);
    expect(Reflect.getMetadata('providers', EpubModule)).toEqual([EpubService]);
  });
});

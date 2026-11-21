import { Global, Module } from '@nestjs/common';

import { LibraryDefaultsService } from './library-defaults.service';
import { DbModule } from '../../db/db.module';
import { LibraryScopeRepository } from './library-scope.repository';
import { LibraryScopeService } from './library-scope.service';

@Global()
@Module({
  imports: [DbModule],
  providers: [LibraryScopeRepository, LibraryScopeService, LibraryDefaultsService],
  exports: [LibraryScopeService, LibraryDefaultsService],
})
export class LibraryScopeModule {}

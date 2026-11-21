import { Controller, Body, Delete, Get, Header, HttpCode, HttpStatus, Param, ParseIntPipe, Put, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { LibraryScopeService } from '../../common/library-scope/library-scope.service';
import { librarySettingsAccount } from '../../common/library-scope/library-settings-scope';
import type { RequestUser } from '../../common/types/request-user';
import { UpdateGlobalPreferencesDto } from './dto/update-global-preferences.dto';
import { UpdateLibraryOverridesDto } from './dto/update-library-overrides.dto';
import { MetadataPreferencesService } from './metadata-preferences.service';

@InteractiveOnly()
@Controller('metadata-preferences')
export class MetadataPreferencesController {
  constructor(
    private readonly service: MetadataPreferencesService,
    private readonly libraries: LibraryScopeService,
  ) {}

  @Get('global')
  @Header('Cache-Control', 'private, no-store')
  getGlobal(@CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    return this.service.getDefaults(librarySettingsAccount(user, scope));
  }

  @Put('global')
  @HttpCode(HttpStatus.OK)
  setGlobal(@Body() dto: UpdateGlobalPreferencesDto, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    return this.service.setDefaults(librarySettingsAccount(user, scope), dto);
  }

  @Get('libraries/:id')
  @Header('Cache-Control', 'private, no-store')
  async getForLibrary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    await this.assertOwner(id, user, scope);
    return this.service.getForLibrary(id);
  }

  @Put('libraries/:id')
  @HttpCode(HttpStatus.OK)
  async setLibraryOverrides(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLibraryOverridesDto,
    @CurrentUser() user: RequestUser,
    @Query('scope') scope?: string,
  ) {
    await this.assertOwner(id, user, scope);
    return this.service.setLibraryOverrides(id, dto.overrides);
  }

  @Delete('global')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetGlobal(@CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    return this.service.resetDefaults(librarySettingsAccount(user, scope));
  }

  @Delete('libraries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetLibraryToGlobal(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    await this.assertOwner(id, user, scope);
    return this.service.resetLibraryToGlobal(id);
  }

  private async assertOwner(id: number, user: RequestUser, scope?: string): Promise<void> {
    if (librarySettingsAccount(user, scope) !== null) await this.libraries.assertLevel(user, id, 'owner');
  }
}

import { MetadataProviderKey } from '@bookorbit/types';
import { BadRequestException, Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';

import { InteractiveOnly } from '../../common/decorators/api-key-policy.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { librarySettingsAccount } from '../../common/library-scope/library-settings-scope';
import type { RequestUser } from '../../common/types/request-user';
import { UpdateProviderConfigDto } from './dto/update-provider-config.dto';
import { ProviderConfigService } from './provider-config.service';

import { IsString, MaxLength } from 'class-validator';

class PersonalExternalAuthorizationDto {
  @IsString()
  @MaxLength(8192)
  authorization!: string;
}

const KNOWN_PROVIDER_KEYS = new Set<MetadataProviderKey>(Object.values(MetadataProviderKey));

@InteractiveOnly()
@Controller('metadata-preferences/providers')
export class ProviderConfigController {
  constructor(private readonly service: ProviderConfigService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  getConfig(@CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    return this.service.getSettingsView(librarySettingsAccount(user, scope));
  }

  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateConfig(@Body() dto: UpdateProviderConfigDto, @CurrentUser() user: RequestUser, @Query('scope') scope?: string) {
    await this.service.updateConfig(dto, librarySettingsAccount(user, scope));
  }

  @Put('external/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setExternalAuthorization(@Param('key') key: string, @Body() dto: PersonalExternalAuthorizationDto, @CurrentUser() user: RequestUser) {
    librarySettingsAccount(user);
    await this.service.setExternalAuthorization(user.id, key, dto.authorization);
  }

  @Post(':key/test')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async testProvider(
    @Param('key') key: string,
    @Body() dto: UpdateProviderConfigDto,
    @CurrentUser() user: RequestUser,
    @Query('scope') scope?: string,
  ) {
    if (!KNOWN_PROVIDER_KEYS.has(key as MetadataProviderKey)) throw new BadRequestException('Unknown provider');
    return this.service.runForAccount(librarySettingsAccount(user, scope), () => this.service.testProvider(key as MetadataProviderKey, dto));
  }
}

import { BadRequestException, Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireScopedPermission } from '../../common/decorators/require-scoped-permission.decorator';
import type { MultipartRequest } from '../../common/types/multipart-request';
import type { RequestUser } from '../../common/types/request-user';
import { AppSettingsService } from '../app-settings/app-settings.service';
import { UploadService } from './upload.service';

@Controller('books')
export class BookFileUploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly appSettings: AppSettingsService,
  ) {}

  @Post(':id/files')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopedPermission(Permission.LibraryUpload, 'book')
  async addFileToBook(@Param('id', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser, @Req() req: MultipartRequest) {
    const limitMb = await this.appSettings.getMaxUploadSizeMb();
    const data = await req.file({ limits: { fileSize: limitMb * 1024 * 1024 } });
    if (!data) throw new BadRequestException('No file provided');
    return this.uploadService.addFileToBook(bookId, data.filename, data.file, user);
  }

  @Post(':id/rename-files')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopedPermission(Permission.LibraryEditMetadata, 'book')
  async renameBookFiles(@Param('id', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser): Promise<void> {
    await this.uploadService.renameBookFiles(bookId, user);
  }
}

import { Module } from '@nestjs/common';

import { BookModule } from '../../book/book.module';
import { EpubController } from './epub.controller';
import { EpubService } from './epub.service';

@Module({
  imports: [BookModule],
  controllers: [EpubController],
  providers: [EpubService],
  exports: [EpubService],
})
export class EpubModule {}

import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { FolderPathQueryDto } from './folder-path-query.dto';

export class SearchFoldersQueryDto extends FolderPathQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  q: string;

  /** "true" also searches the operating-system folders under `/`. */
  @IsOptional()
  @IsIn(['true', 'false'])
  system?: string;
}

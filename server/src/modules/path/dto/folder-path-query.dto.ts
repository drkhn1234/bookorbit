import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PathScopeDto } from './path-scope.dto';

export class FolderPathQueryDto extends PathScopeDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  path?: string;
}

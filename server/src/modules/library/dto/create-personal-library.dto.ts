import { IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { LibrarySettingsDto } from './create-library.dto';
import { IsOptionalNotNull } from './optional-not-null.decorator';

export class CreatePersonalLibraryDto extends LibrarySettingsDto {
  @IsOptionalNotNull()
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(4096, { each: true })
  folders?: string[];
}

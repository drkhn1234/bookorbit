import { IsIn, IsOptional } from 'class-validator';
import type { PathScope } from '../path-policy.service';

export class PathScopeDto {
  @IsOptional()
  @IsIn(['personal', 'admin'])
  scope?: PathScope;
}

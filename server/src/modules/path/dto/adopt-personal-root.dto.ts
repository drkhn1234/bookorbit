import { IsInt, Min } from 'class-validator';

export class AdoptPersonalRootDto {
  @IsInt()
  @Min(1)
  userId: number;
}

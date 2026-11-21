import { UseGuards } from '@nestjs/common';
import { LibraryAdministratorModeGuard } from '../../common/library-scope/library-settings-scope';
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { UpdateWeightsDto } from './dto/update-weights.dto';
import { MetadataRecalculationTrigger, MetadataScoreService } from './metadata-score.service';

@Controller('metadata-score')
export class MetadataScoreController {
  constructor(private readonly service: MetadataScoreService) {}

  @Get('weights')
  getWeights() {
    return this.service.getWeights();
  }

  @Patch('weights')
  @UseGuards(LibraryAdministratorModeGuard)
  @RequirePermission(Permission.ManageAppSettings)
  updateWeights(@Body() dto: UpdateWeightsDto) {
    return this.service.updateWeights(dto);
  }

  @Post('recalculate')
  @UseGuards(LibraryAdministratorModeGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(Permission.ManageAppSettings)
  recalculate() {
    const result = this.service.requestRecalculation(MetadataRecalculationTrigger.MANUAL);
    return {
      started: result.started,
      status: result.status,
      message: result.started ? 'Recalculation started' : 'Recalculation already running',
    };
  }

  @Get('recalculate/status')
  @UseGuards(LibraryAdministratorModeGuard)
  @RequirePermission(Permission.ManageAppSettings)
  getRecalculationStatus() {
    return this.service.getRecalculationStatus();
  }
}

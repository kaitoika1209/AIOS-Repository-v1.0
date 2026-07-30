import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@aios/contracts';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok', service: 'api', version: '0.0.0' };
  }
}

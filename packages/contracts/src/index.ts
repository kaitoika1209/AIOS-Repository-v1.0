export interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'api' | 'worker';
  readonly version: string;
}

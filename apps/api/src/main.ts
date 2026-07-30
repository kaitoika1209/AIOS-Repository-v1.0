import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseEnvironment } from '@aios/config';
import { AppModule } from './app.module.js';

const environment = parseEnvironment(process.env);
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.enableShutdownHooks();
await app.listen(environment.AIOS_API_PORT, '0.0.0.0');

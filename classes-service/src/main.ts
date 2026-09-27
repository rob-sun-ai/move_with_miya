import './telemetry';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ClassesModule } from './classes.module';
import { recordHttpRequest } from './metrics';
import { assertProductionConfig } from './config-validation';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

config({ path: resolve(process.cwd(), '../.env') });

async function bootstrap() {
  assertProductionConfig(['DATABASE_URL', 'RABBITMQ_URL']);
  const app = await NestFactory.create(ClassesModule);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    const incomingRequestId = req.header('x-request-id');
    const requestId =
      incomingRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    res.setHeader('X-Request-ID', requestId);
    res.on('finish', () => {
      const durationMs = Date.now() - started;
      const route = (req as unknown as { route?: { path?: unknown } }).route;
      recordHttpRequest(
        req.method,
        typeof route?.path === 'string' ? route.path : 'unmatched',
        res.statusCode,
        durationMs,
      );
      console.log(
        JSON.stringify({
          event: 'http_request',
          service: process.env.OTEL_SERVICE_NAME ?? 'classes-service',
          requestId,
          traceparent: req.header('traceparent') ?? null,
          method: req.method,
          route: req.path,
          statusCode: res.statusCode,
          durationMs,
        }),
      );
    });
    next();
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
      queue: 'classes_queue',
      queueOptions: { durable: true },
    },
  });
  await app.startAllMicroservices();
  await app.listen(Number(process.env.HEALTH_PORT ?? 3004));
}
void bootstrap();

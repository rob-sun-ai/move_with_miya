import './telemetry';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import session from 'express-session';
import { createClient } from 'redis';
import type { NextFunction, Request, Response } from 'express';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RedisStore } = require('connect-redis') as {
  RedisStore: new (opts: {
    client: import('redis').RedisClientType;
  }) => import('express-session').Store;
};
import { AppModule } from './app.module';
import { recordHttpRequest } from './metrics';
import { assertProductionConfig } from './config-validation';
import { randomUUID } from 'node:crypto';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV');
  const sessionSecret = configService.get<string>('SESSION_SECRET');
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  assertProductionConfig(configService, [
    'SESSION_SECRET',
    'CORS_ORIGIN',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALLBACK_URL',
    'REDIS_URL',
    'RABBITMQ_URL',
    'DATABASE_URL',
  ]);
  if (
    nodeEnv === 'production' &&
    (!sessionSecret ||
      sessionSecret.length < 32 ||
      [
        'change-me-to-a-random-string',
        'dev-secret-change-in-production',
      ].includes(sessionSecret))
  ) {
    throw new Error(
      'SESSION_SECRET must be a strong, non-placeholder value in production',
    );
  }
  if (nodeEnv === 'production') {
    let parsedOrigin: URL | undefined;
    try {
      parsedOrigin = corsOrigin ? new URL(corsOrigin) : undefined;
    } catch {
      parsedOrigin = undefined;
    }
    if (
      !parsedOrigin ||
      parsedOrigin.protocol !== 'https:' ||
      parsedOrigin.origin !== corsOrigin
    ) {
      throw new Error(
        'CORS_ORIGIN must be a single HTTPS origin in production',
      );
    }
  }

  // nginx terminates TLS. Without trusting it, req.secure is false and
  // express-session silently refuses to send the Secure session cookie.
  app.set('trust proxy', nodeEnv === 'production' ? 1 : false);

  const redisClient = createClient({
    url: configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
  });
  // node-redis reconnects on its own; without a listener an 'error' event
  // during a Redis outage would crash the process instead.
  const redisLogger = new Logger('Redis');
  redisClient.on('error', (error: unknown) =>
    redisLogger.error(
      error instanceof Error ? (error.stack ?? error.message) : 'Redis error',
    ),
  );
  await redisClient.connect();

  app.use(
    session({
      store: new RedisStore({ client: redisClient }),
      secret: sessionSecret || 'dev-secret-change-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: nodeEnv === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  app.enableCors({
    origin: corsOrigin || 'http://localhost:5173',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

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
          service: process.env.OTEL_SERVICE_NAME ?? 'user-service',
          requestId,
          traceparent: req.header('traceparent') ?? null,
          method: req.method,
          route: req.path.replace(/\d+/g, ':id'),
          statusCode: res.statusCode,
          durationMs,
        }),
      );
    });
    next();
  });

  const port = configService.get<number>('PORT', 3003);
  await app.listen(port);
  console.log(`user-service listening on http://localhost:${port}`);
}
void bootstrap();

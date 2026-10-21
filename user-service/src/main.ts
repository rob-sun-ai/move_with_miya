import './telemetry';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import session from 'express-session';
import { createClient } from 'redis';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RedisStore } = require('connect-redis') as {
  RedisStore: new (opts: {
    client: import('redis').RedisClientType;
  }) => import('express-session').Store;
};
import { AppModule } from './app.module';
import { requestTelemetry } from './metrics';
import { assertProductionConfig } from './config-validation';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // First, so CORS preflights and body-parser or session failures are still
  // counted, logged, and tagged with a request ID.
  app.use(requestTelemetry('user-service'));
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
    'DATABASE_URL',
  ]);

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

  const port = configService.get<number>('PORT', 3003);
  await app.listen(port);
  console.log(`user-service listening on http://localhost:${port}`);
}
void bootstrap();

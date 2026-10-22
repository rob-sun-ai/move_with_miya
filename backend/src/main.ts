import './telemetry';
import { NestFactory } from '@nestjs/core';
import {
  ExpressAdapter,
  NestExpressApplication,
} from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import session from 'express-session';
import { AppModule } from './app.module';
import { RedisService } from './redis.service';
import type { RedisClient } from './redis.service';
import express from 'express';
import { requestTelemetry } from './metrics';
import { assertProductionConfig } from './config-validation';
import { createExpressServer } from './express-server';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RedisStore } = require('connect-redis') as {
  RedisStore: new (opts: {
    client: RedisClient;
  }) => import('express-session').Store;
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(createExpressServer()),
    {
      // Stripe webhook signatures are computed over the raw request body.
      bodyParser: false,
    },
  );
  // First, so CORS preflights and body-parser or session failures are still
  // counted, logged, and tagged with a request ID.
  app.use(requestTelemetry('backend'));
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV');
  const corsOrigin = configService.get<string>('CORS_ORIGIN');
  const sessionSecret = configService.get<string>('SESSION_SECRET');
  assertProductionConfig(configService, [
    'SESSION_SECRET',
    'CORS_ORIGIN',
    'PUBLIC_APP_URL',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_CURRENCY',
    'RESEND_API_KEY',
    'CONTACT_EMAIL_TO',
    'RESEND_FROM_EMAIL',
    'CONTACT_CHALLENGE_SECRET',
    'TURNSTILE_SECRET_KEY',
    'TURNSTILE_HOSTNAME',
    'REDIS_URL',
    'RABBITMQ_URL',
  ]);

  app.enableCors({
    origin: corsOrigin || 'http://localhost:5173',
    credentials: true,
  });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [
        configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672',
      ],
      queue: 'registration_events',
      queueOptions: { durable: true },
    },
  });

  app.set('trust proxy', nodeEnv === 'production' ? 1 : false);

  const redisService = app.get(RedisService);
  await redisService.connect();

  app.use(
    '/checkout/webhook',
    express.raw({ type: 'application/json', limit: '256kb' }),
  );
  app.use(express.json({ limit: '256kb' }));

  app.use(
    session({
      store: new RedisStore({ client: redisService.getClient() }),
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

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = configService.get<number>('PORT', 3002);
  await app.startAllMicroservices();
  await app.listen(port);
  console.log(`backend listening on http://localhost:${port}`);
}
void bootstrap();

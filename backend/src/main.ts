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
  );
  const configService = app.get(ConfigService);

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

  app.set(
    'trust proxy',
    configService.get<string>('NODE_ENV') === 'production' ? 1 : false,
  );

  const redisService = app.get(RedisService);
  await redisService.connect();

  app.use(
    session({
      store: new RedisStore({ client: redisService.getClient() }),
      secret: configService.get<string>(
        'SESSION_SECRET',
        'dev-secret-change-in-production',
      ),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: configService.get<string>('NODE_ENV') === 'production',
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

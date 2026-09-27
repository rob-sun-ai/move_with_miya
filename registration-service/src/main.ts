import './telemetry';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { RegistrationModule } from './registration.module';
import { requestTelemetry } from './metrics';
import { assertProductionConfig } from './config-validation';

config({ path: resolve(process.cwd(), '../.env') });

async function bootstrap() {
  assertProductionConfig(['DATABASE_URL', 'RABBITMQ_URL']);
  const app = await NestFactory.create(RegistrationModule);
  app.use(requestTelemetry('registration-service'));
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
      queue: 'registration_queue',
      queueOptions: { durable: true },
    },
  });
  await app.startAllMicroservices();
  await app.listen(Number(process.env.HEALTH_PORT ?? 3005));
}
void bootstrap();

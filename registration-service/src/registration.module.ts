import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxPublisher } from './outbox.publisher';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { PaymentMetrics } from './payment-metrics';

@Module({
  imports: [
    PrismaModule,
    ClientsModule.register([
      {
        name: 'REGISTRATION_EVENTS',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
          queue: 'registration_events',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [RegistrationController, HealthController],
  providers: [
    RegistrationService,
    OutboxPublisher,
    HealthService,
    PaymentMetrics,
  ],
})
export class RegistrationModule {}

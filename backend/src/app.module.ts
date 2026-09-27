import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClassesController } from './externalControllers/ClassesController';
import { LocationController } from './externalControllers/LocationController';
import { RegistrationController } from './externalControllers/RegistrationController';
import { ContactController } from './externalControllers/ContactController';
import { AdminGuard } from './common/guards/admin.guard';
import { StaffGuard } from './common/guards/staff.guard';
import { ContactEmailService } from './externalControllers/contact-email.service';
import { ContactChallengeService } from './externalControllers/contact-challenge.service';
import { ContactRateLimitService } from './externalControllers/contact-rate-limit.service';
import { TurnstileService } from './externalControllers/turnstile.service';
import { ContactRateLimitGuard } from './common/guards/contact-rate-limit.guard';
import { RedisService } from './redis.service';
import { RegistrationEventsController } from './externalControllers/registration-events.controller';
import { RegistrationNotificationService } from './externalControllers/registration-notification.service';
import { StripeController } from './externalControllers/StripeController';
import { StripeService } from './externalControllers/stripe.service';
import { CheckoutRateLimitService } from './common/checkout-rate-limit.service';
import { CheckoutRateLimitGuard } from './common/guards/checkout-rate-limit.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env.local', '../.env'],
    }),
    ClientsModule.register([
      {
        name: 'CLASSES_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'classes_queue',
          queueOptions: { durable: true },
        },
      },
      {
        name: 'REGISTRATION_SERVICE',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
          queue: 'registration_queue',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [
    AppController,
    ClassesController,
    LocationController,
    RegistrationController,
    ContactController,
    RegistrationEventsController,
    StripeController,
  ],
  providers: [
    AppService,
    AdminGuard,
    StaffGuard,
    ContactEmailService,
    ContactChallengeService,
    TurnstileService,
    ContactRateLimitService,
    ContactRateLimitGuard,
    RedisService,
    RegistrationNotificationService,
    StripeService,
    CheckoutRateLimitService,
    CheckoutRateLimitGuard,
  ],
})
export class AppModule {}

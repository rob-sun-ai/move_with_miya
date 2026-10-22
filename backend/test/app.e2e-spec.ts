import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AdminGuard } from './../src/common/guards/admin.guard';
import { ContactRateLimitGuard } from './../src/common/guards/contact-rate-limit.guard';
import { ContactChallengeService } from './../src/externalControllers/contact-challenge.service';
import { ContactEmailService } from './../src/externalControllers/contact-email.service';
import { ContactRateLimitService } from './../src/externalControllers/contact-rate-limit.service';
import { TurnstileService } from './../src/externalControllers/turnstile.service';
import { of } from 'rxjs';
import { ExpressAdapter } from '@nestjs/platform-express';
import { createExpressServer } from './../src/express-server';
import { CheckoutRateLimitService } from './../src/common/checkout-rate-limit.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let registrationClient: { send: jest.Mock };
  let classesClient: { send: jest.Mock };
  let checkoutRateLimit: Record<string, jest.Mock>;

  beforeEach(async () => {
    registrationClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'create_contact_submission') {
          return of({ id: 1, name: 'A Person' });
        }
        if (pattern.cmd === 'mark_contact_submission_read') {
          return of({ id: 3, read: true });
        }
        if (pattern.cmd === 'get_all_registrations') return of([]);
        return of([]);
      }),
    };
    classesClient = { send: jest.fn().mockReturnValue(of([])) };
    const allowed = {
      allowed: true,
      limit: 30,
      remaining: 29,
      resetSeconds: 60,
    };
    checkoutRateLimit = {
      consumeIp: jest.fn().mockResolvedValue(allowed),
      consumeUser: jest.fn().mockResolvedValue(allowed),
      consumeRefundIp: jest.fn().mockResolvedValue(allowed),
      consumeStatusIp: jest.fn().mockResolvedValue(allowed),
      applyHeaders: jest.fn(),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('REGISTRATION_SERVICE')
      .useValue(registrationClient)
      .overrideProvider('CLASSES_SERVICE')
      .useValue(classesClient)
      .overrideProvider(ContactEmailService)
      .useValue({ notify: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(ContactChallengeService)
      .useValue({ isValid: jest.fn().mockReturnValue(true) })
      .overrideProvider(ContactRateLimitService)
      .useValue({
        getVisitorId: jest.fn().mockReturnValue('visitor-id'),
        applyHeaders: jest.fn(),
        consumeVerifiedSubmission: jest.fn().mockResolvedValue({
          allowed: true,
          limit: 3,
          remaining: 2,
          resetSeconds: 60,
        }),
      })
      .overrideProvider(TurnstileService)
      .useValue({ verify: jest.fn().mockResolvedValue(true) })
      .overrideProvider(CheckoutRateLimitService)
      .useValue(checkoutRateLimit)
      .overrideGuard(ContactRateLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication(
      new ExpressAdapter(createExpressServer()),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer()).get('/').expect(200).expect('OK');
  });

  it('accepts a valid contact submission and returns the saved record', () => {
    return request(app.getHttpServer())
      .post('/contact')
      .send({
        name: ' A Person ',
        email: ' person@example.com ',
        subject: ' Question ',
        message: ' Hello studio ',
        turnstileToken: 'test-turnstile-token',
        contactChallenge: 'test-contact-challenge',
      })
      .set('Cookie', 'contact_visitor=visitor-id')
      .expect(201)
      .expect({ id: 1, name: 'A Person' });
  });

  it('rejects blank contact fields', () => {
    return request(app.getHttpServer())
      .post('/contact')
      .send({
        name: '   ',
        email: 'person@example.com',
        subject: 'Question',
        message: 'Hello',
        turnstileToken: 'test-turnstile-token',
        contactChallenge: 'test-contact-challenge',
      })
      .set('Cookie', 'contact_visitor=visitor-id')
      .expect(400);
  });

  it('allows an admin to update contact read state', () => {
    return request(app.getHttpServer())
      .patch('/contact/3/read')
      .send({ read: true })
      .expect(200)
      .expect({ id: 3, read: true });
  });

  it('lists all registrations through the admin endpoint', () => {
    return request(app.getHttpServer())
      .get('/registration')
      .expect(200)
      .expect([]);
  });

  it('matches routes case-sensitively so proxy path rules cannot be dodged', async () => {
    await request(app.getHttpServer()).get('/registration').expect(200);
    await request(app.getHttpServer()).get('/REGISTRATION').expect(404);
    await request(app.getHttpServer()).get('/Registration').expect(404);
  });

  it('does not advertise the framework', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('rate-limits checkout requests by the route they matched', async () => {
    await request(app.getHttpServer()).get('/checkout/status/?session_id=cs_1');
    await request(app.getHttpServer()).post('/checkout/payments/p1/refund');

    expect(checkoutRateLimit.consumeStatusIp).toHaveBeenCalledWith(
      '/checkout/status',
      expect.any(String),
    );
    expect(checkoutRateLimit.consumeRefundIp).toHaveBeenCalledWith(
      '/checkout/payments/refund',
      expect.any(String),
    );
  });

  it('cancels a registration when the admin sends no body', async () => {
    registrationClient.send.mockImplementation((pattern: { cmd: string }) =>
      of(
        pattern.cmd === 'get_registration'
          ? { id: 4, classId: 2 }
          : { id: 4, status: 'Canceled' },
      ),
    );
    classesClient.send.mockReturnValue(
      of({ id: 2, capacity: 10, startDate: '2099-01-01T10:00:00.000Z' }),
    );

    await request(app.getHttpServer())
      .post('/registration/4/cancel')
      .expect(201)
      .expect({ id: 4, status: 'Canceled' });
  });

  it('rejects an out-of-range admin refund percentage', () => {
    return request(app.getHttpServer())
      .post('/registration/4/cancel')
      .send({ refundPercentage: 150 })
      .expect(400);
  });

  afterEach(async () => {
    await app.close();
  });
});

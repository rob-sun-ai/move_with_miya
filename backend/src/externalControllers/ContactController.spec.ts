import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { of, throwError } from 'rxjs';
import { ContactRateLimitGuard } from '../common/guards/contact-rate-limit.guard';
import { ContactController } from './ContactController';
import { ContactChallengeService } from './contact-challenge.service';
import {
  ContactRateLimitService,
  RateLimitDecision,
} from './contact-rate-limit.service';
import { ContactEmailService } from './contact-email.service';
import { TurnstileService } from './turnstile.service';

jest.mock('../common/guards/admin.guard', () => ({
  AdminGuard: jest.fn().mockImplementation(() => ({ canActivate: () => true })),
}));

describe('ContactController', () => {
  let controller: ContactController;
  let testingModule: TestingModule | undefined;
  let client: { send: jest.Mock };
  let emailService: { notify: jest.Mock };
  let challengeService: { issue: jest.Mock; isValid: jest.Mock };
  let turnstileService: { verify: jest.Mock };
  let rateLimitService: {
    ensureVisitorCookie: jest.Mock;
    getVisitorId: jest.Mock;
    consumeVerifiedSubmission: jest.Mock;
    applyHeaders: jest.Mock;
  };
  let response: Response;

  const decision = (allowed = true): RateLimitDecision => ({
    allowed,
    limit: 3,
    remaining: allowed ? 2 : 0,
    resetSeconds: 60,
  });

  const request = (cookie = 'contact_visitor=visitor-id') =>
    ({
      ip: '198.51.100.10',
      headers: { cookie },
    }) as unknown as Request;

  const dto = {
    name: 'A Person',
    email: 'person@example.com',
    subject: 'Question',
    message: 'Hello studio',
    turnstileToken: 'turnstile-token',
    contactChallenge: 'contact-challenge',
  };

  beforeEach(async () => {
    client = { send: jest.fn() };
    emailService = { notify: jest.fn().mockResolvedValue(undefined) };
    challengeService = {
      issue: jest.fn().mockReturnValue('challenge'),
      isValid: jest.fn().mockReturnValue(true),
    };
    turnstileService = { verify: jest.fn().mockResolvedValue(true) };
    rateLimitService = {
      ensureVisitorCookie: jest.fn().mockReturnValue('visitor-id'),
      getVisitorId: jest.fn().mockReturnValue('visitor-id'),
      consumeVerifiedSubmission: jest.fn().mockResolvedValue(decision(true)),
      applyHeaders: jest.fn(),
    };
    response = { cookie: jest.fn(), header: jest.fn() } as unknown as Response;
    testingModule = await Test.createTestingModule({
      controllers: [ContactController],
      providers: [
        { provide: 'REGISTRATION_SERVICE', useValue: client },
        { provide: ContactEmailService, useValue: emailService },
        { provide: ContactChallengeService, useValue: challengeService },
        { provide: TurnstileService, useValue: turnstileService },
        { provide: ContactRateLimitService, useValue: rateLimitService },
        { provide: ContactRateLimitGuard, useValue: {} },
      ],
    }).compile();
    controller = testingModule.get(ContactController);
  });

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
  });

  it('issues a cookie-bound challenge', () => {
    expect(controller.getChallenge(request(''), response)).toEqual({
      token: 'challenge',
    });
    expect(rateLimitService.ensureVisitorCookie).toHaveBeenCalledWith(
      expect.anything(),
      response,
    );
    expect(challengeService.issue).toHaveBeenCalledWith('visitor-id');
  });

  it('stores a verified submission and starts notification without waiting', async () => {
    const saved = { id: 1, ...dto };
    client.send.mockReturnValue(of(saved));

    await expect(controller.create(dto, request(), response)).resolves.toEqual(
      saved,
    );
    expect(challengeService.isValid).toHaveBeenCalledWith(
      dto.contactChallenge,
      'visitor-id',
    );
    expect(turnstileService.verify).toHaveBeenCalledWith(
      dto.turnstileToken,
      '198.51.100.10',
    );
    expect(rateLimitService.consumeVerifiedSubmission).toHaveBeenCalledWith(
      'visitor-id',
    );
    expect(client.send).toHaveBeenCalledWith(
      { cmd: 'create_contact_submission' },
      {
        name: dto.name,
        email: dto.email,
        subject: dto.subject,
        message: dto.message,
      },
    );
    expect(emailService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ name: dto.name, email: dto.email }),
    );
  });

  it('does not consume the browser quota for a missing cookie', async () => {
    rateLimitService.getVisitorId.mockReturnValue(undefined);

    await expect(controller.create(dto, request(''), response)).rejects.toThrow(
      'Please reload the page',
    );
    expect(challengeService.isValid).not.toHaveBeenCalled();
    expect(turnstileService.verify).not.toHaveBeenCalled();
    expect(rateLimitService.consumeVerifiedSubmission).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('does not persist a submission when the challenge is invalid', async () => {
    challengeService.isValid.mockReturnValue(false);

    await expect(controller.create(dto, request(), response)).rejects.toThrow(
      BadRequestException,
    );
    expect(turnstileService.verify).not.toHaveBeenCalled();
    expect(rateLimitService.consumeVerifiedSubmission).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('does not persist a submission when CAPTCHA fails', async () => {
    turnstileService.verify.mockResolvedValue(false);

    await expect(controller.create(dto, request(), response)).rejects.toThrow(
      'Captcha verification failed',
    );
    expect(rateLimitService.consumeVerifiedSubmission).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    expect(emailService.notify).not.toHaveBeenCalled();
  });

  it('rejects a verified submission when the browser quota is exhausted', async () => {
    rateLimitService.consumeVerifiedSubmission.mockResolvedValue(
      decision(false),
    );

    await expect(controller.create(dto, request(), response)).rejects.toEqual(
      expect.objectContaining({
        status: 429,
        message: 'Too many contact submissions. Please try again later.',
      }),
    );
    expect(rateLimitService.applyHeaders).toHaveBeenCalledWith(
      response,
      decision(false),
      'Visitor',
    );
    expect(client.send).not.toHaveBeenCalled();
    expect(emailService.notify).not.toHaveBeenCalled();
  });

  it('returns the saved submission when notification remains pending', async () => {
    const saved = { id: 1, ...dto };
    client.send.mockReturnValue(of(saved));
    emailService.notify.mockReturnValue(new Promise(() => undefined));

    await expect(controller.create(dto, request(), response)).resolves.toEqual(
      saved,
    );
  });

  it('translates Redis failures during the browser check to service unavailable', async () => {
    rateLimitService.consumeVerifiedSubmission.mockRejectedValue(
      new Error('Redis unavailable'),
    );

    await expect(controller.create(dto, request(), response)).rejects.toEqual(
      expect.objectContaining({ status: 503 }),
    );
    expect(client.send).not.toHaveBeenCalled();
  });

  it('marks a contact submission read or unread', async () => {
    const updated = { id: 4, read: true };
    client.send.mockReturnValue(of(updated));

    await expect(controller.markRead(4, { read: true })).resolves.toEqual(
      updated,
    );
    expect(client.send).toHaveBeenCalledWith(
      { cmd: 'mark_contact_submission_read' },
      { id: 4, read: true },
    );
  });

  it('lists submissions with optional paging', async () => {
    client.send.mockReturnValue(of([]));

    await expect(controller.findAll()).resolves.toEqual([]);
    await controller.findAll(20, 40);

    expect(client.send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'get_contact_submissions' },
      { take: undefined, skip: undefined },
    );
    expect(client.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'get_contact_submissions' },
      { take: 20, skip: 40 },
    );
  });

  it.each([
    [0, undefined],
    [101, undefined],
    [10, -1],
  ])('rejects take %p with skip %p', (take, skip) => {
    expect(() => controller.findAll(take, skip)).toThrow(BadRequestException);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('reports an unavailable registration service when saving fails', async () => {
    client.send.mockReturnValue(
      throwError(() => ({ status: 'error', message: 'Internal server error' })),
    );

    await expect(controller.create(dto, request(), response)).rejects.toEqual(
      new ServiceUnavailableException(
        'Contact service is temporarily unavailable',
      ),
    );
    expect(emailService.notify).not.toHaveBeenCalled();
  });
});

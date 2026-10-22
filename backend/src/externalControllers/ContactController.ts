import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { Request, Response } from 'express';
import { AdminGuard } from '../common/guards/admin.guard';
import { ContactRateLimitGuard } from '../common/guards/contact-rate-limit.guard';
import { sendRpc } from '../common/rpc';
import { CreateContactSubmissionDto } from './dto/create-contact-submission.dto';
import { UpdateContactReadDto } from './dto/update-contact-read.dto';
import { ContactEmailService } from './contact-email.service';
import { ContactChallengeService } from './contact-challenge.service';
import {
  ContactRateLimitService,
  type RateLimitDecision,
} from './contact-rate-limit.service';
import { TurnstileService } from './turnstile.service';

const MAX_PAGE_SIZE = 100;

interface ContactSubmissionRecord {
  id: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  createdAt: string;
  read: boolean;
}

@Controller('contact')
export class ContactController {
  constructor(
    @Inject('REGISTRATION_SERVICE')
    private readonly registrationClient: ClientProxy,
    private readonly contactEmailService: ContactEmailService,
    private readonly turnstileService: TurnstileService,
    private readonly contactChallengeService: ContactChallengeService,
    private readonly contactRateLimitService: ContactRateLimitService,
  ) {}

  @Get('challenge')
  getChallenge(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const visitorId = this.contactRateLimitService.ensureVisitorCookie(
      request,
      response,
    );
    return { token: this.contactChallengeService.issue(visitorId) };
  }

  @UseGuards(ContactRateLimitGuard)
  @Post()
  async create(
    @Body() dto: CreateContactSubmissionDto,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { turnstileToken, contactChallenge, ...submissionDto } = dto;
    const visitorId = this.contactRateLimitService.getVisitorId(req);
    if (!visitorId) {
      throw new BadRequestException(
        'Contact verification is unavailable. Please reload the page.',
      );
    }
    if (!this.contactChallengeService.isValid(contactChallenge, visitorId)) {
      throw new BadRequestException(
        'Please keep this page open for a few seconds before submitting',
      );
    }
    const verified = await this.turnstileService.verify(turnstileToken, req.ip);
    if (!verified) {
      throw new BadRequestException('Captcha verification failed');
    }

    let decision: RateLimitDecision;
    try {
      decision =
        await this.contactRateLimitService.consumeVerifiedSubmission(visitorId);
    } catch {
      throw new ServiceUnavailableException(
        'Contact service is temporarily unavailable',
      );
    }
    this.contactRateLimitService.applyHeaders(response, decision, 'Visitor');
    if (!decision.allowed) {
      throw new HttpException(
        'Too many contact submissions. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const submission = await this.rpc<ContactSubmissionRecord>(
      'create_contact_submission',
      submissionDto,
    );
    void this.contactEmailService.notify(submissionDto);
    return submission;
  }

  @UseGuards(AdminGuard)
  @Get()
  findAll(
    @Query('take', new ParseIntPipe({ optional: true })) take?: number,
    @Query('skip', new ParseIntPipe({ optional: true })) skip?: number,
  ) {
    if (take !== undefined && (take < 1 || take > MAX_PAGE_SIZE)) {
      throw new BadRequestException(
        `take must be between 1 and ${MAX_PAGE_SIZE}`,
      );
    }
    if (skip !== undefined && skip < 0) {
      throw new BadRequestException('skip must not be negative');
    }
    return this.rpc<ContactSubmissionRecord[]>('get_contact_submissions', {
      take,
      skip,
    });
  }

  @UseGuards(AdminGuard)
  @Patch(':id/read')
  markRead(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContactReadDto,
  ) {
    return this.rpc<ContactSubmissionRecord>('mark_contact_submission_read', {
      id,
      read: dto.read,
    });
  }

  private rpc<T>(cmd: string, payload: object) {
    return sendRpc<T>(
      this.registrationClient,
      cmd,
      payload,
      'Contact service is temporarily unavailable',
    );
  }
}

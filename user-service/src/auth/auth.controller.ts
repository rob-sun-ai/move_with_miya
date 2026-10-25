import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  Query,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { User } from '../generated/prisma/client';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { loadSessionUser } from '../common/session-user';

/** Awaits one of express-session's callback-style operations. */
function sessionStep(
  step: (done: (error?: unknown) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) =>
    step((error) =>
      error
        ? reject(
            error instanceof Error ? error : new Error('Session store error'),
          )
        : resolve(),
    ),
  );
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Get('google')
  googleAuth(@Req() req: Request, @Res() res: Response): void {
    const state = uuid();
    req.session.state = state;
    const url = this.authService.getGoogleAuthURL(state);
    res.redirect(url);
  }

  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code: string,
    @Query('state') state: string,
  ): Promise<void> {
    const frontendUrl = this.authService.getFrontendUrl();
    try {
      await this.signIn(req, code, state);
    } catch (error) {
      // The browser arrives here from Google, so a failure is shown on the
      // login page instead of as a raw JSON error.
      this.logger.warn(
        `Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.redirect(new URL('/login?error=signin', frontendUrl).toString());
      return;
    }
    res.redirect(frontendUrl);
  }

  private async signIn(
    req: Request,
    code: string | undefined,
    state: string | undefined,
  ): Promise<void> {
    const savedState = req.session.state;
    if (!state || state !== savedState) {
      throw new UnauthorizedException(
        'Invalid state parameter — possible CSRF',
      );
    }
    if (!code) throw new BadRequestException('Missing authorization code');

    const { accessToken } = await this.authService.exchangeCode(code);
    const profile = await this.authService.fetchGoogleProfile(accessToken);
    const user: User = await this.authService.findOrCreateUser(profile);

    // A new session ID on login stops a session fixed before sign-in from
    // becoming authenticated, and drops the single-use OAuth state.
    await sessionStep((done) => req.session.regenerate(done));
    req.session.userId = user.id;
    await sessionStep((done) => req.session.save(done));
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Reporting success while the session survives in Redis would leave the
    // user signed in without knowing it.
    await sessionStep((done) => req.session.destroy(done)).catch(() => {
      throw new ServiceUnavailableException('Could not end session');
    });
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  }

  @Get('me')
  me(@Req() req: Request): Promise<User> {
    return loadSessionUser(this.usersService, req);
  }
}

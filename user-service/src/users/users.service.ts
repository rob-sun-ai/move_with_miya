import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { User, UserRole } from '../generated/prisma/client';
import type { CreateUserDto } from './dto/create-user.dto';
import type { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto): Promise<User> {
    return this.prisma.client.user.create({ data: dto });
  }

  async findAll(): Promise<User[]> {
    return this.prisma.client.user.findMany();
  }

  async findById(id: string): Promise<User> {
    const user = await this.prisma.client.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  async findByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    return this.prisma.client.user.findMany({
      where: { id: { in: ids } },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.client.user.findUnique({ where: { email } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.prisma.client.user.findUnique({ where: { googleId } });
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    await this.findById(id);
    return this.prisma.client.user.update({ where: { id }, data: dto });
  }

  async updateLastLogin(id: string): Promise<User> {
    await this.findById(id);
    return this.prisma.client.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  async linkGoogleAccount(id: string, googleId: string): Promise<User> {
    return this.prisma.client.user.update({
      where: { id },
      data: { googleId, lastLoginAt: new Date() },
    });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.client.user.delete({ where: { id } });
  }

  async updateRole(id: string, role: UserRole): Promise<User> {
    await this.findById(id);
    return this.prisma.client.user.update({
      where: { id },
      data: { role },
    });
  }

  async toggleBan(id: string): Promise<User> {
    return this.prisma.client.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw new NotFoundException(`User ${id} not found`);
      return tx.user.update({
        where: { id },
        data: { banned: !user.banned },
      });
    });
  }
}

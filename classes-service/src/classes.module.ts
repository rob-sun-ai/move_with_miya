import { Module } from '@nestjs/common';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';
import { LocationModule } from './location/location.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PrismaModule, LocationModule],
  controllers: [ClassesController, HealthController],
  providers: [ClassesService, HealthService],
})
export class ClassesModule {}

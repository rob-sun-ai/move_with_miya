import { Controller, UseFilters } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ClassesService } from './classes.service';
import { asPayload } from './payload-validation';
import { RpcErrorFilter } from './rpc-exception.filter';

@Controller()
@UseFilters(new RpcErrorFilter())
export class ClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @MessagePattern({ cmd: 'get_classes' })
  findClasses() {
    return this.classesService.findClasses();
  }

  @MessagePattern({ cmd: 'get_classes_in_range' })
  findClassesInRange(data: unknown) {
    const { from, to } = asPayload(data);
    return this.classesService.findClassesInRange(from, to);
  }

  @MessagePattern({ cmd: 'get_class' })
  findClass(data: unknown) {
    return this.classesService.findClass(asPayload(data).id);
  }

  @MessagePattern({ cmd: 'create_class' })
  createClass(data: unknown) {
    return this.classesService.createClass(asPayload(data));
  }

  @MessagePattern({ cmd: 'update_class' })
  updateClass(data: unknown) {
    const { id, ...rest } = asPayload(data);
    return this.classesService.updateClass(id, rest);
  }

  @MessagePattern({ cmd: 'delete_class' })
  deleteClass(data: unknown) {
    return this.classesService.deleteClass(asPayload(data).id);
  }
}

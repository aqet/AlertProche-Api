import {
  Controller, Get, Patch, Delete,
  Param, Query, Body, UseGuards, Request,
  HttpCode, HttpStatus,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { IsEnum } from 'class-validator';

class UpdateRoleDto {
  @IsEnum(['Standard', 'Moderateur', 'Admin'])
  role: 'Standard' | 'Moderateur' | 'Admin';
}

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('Admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // GET /admin/stats — Statistiques globales
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  // GET /admin/users — Liste paginée des utilisateurs
  @Get('users')
  async getUsers(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('search') search?: string,
  ): Promise<any> {
    return this.adminService.getAllUsers(+page, +limit, search);
  }

  // PATCH /admin/users/:id/role — Changer le rôle d'un utilisateur
  @Patch('users/:id/role')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Request() req: any,
  ) {
    return this.adminService.updateUserRole(id, dto.role, req.user);
  }

  // DELETE /admin/users/:id — Supprimer un compte
  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(@Param('id') id: string, @Request() req: any) {
    return this.adminService.deleteUser(id, req.user);
  }

  // GET /admin/posts — Tous les posts avec filtres
  @Get('posts')
  async getPosts(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('filter') filter?: string,
  ): Promise<any> {
    return this.adminService.getAllPostsAdmin(+page, +limit, filter);
  }

  // DELETE /admin/posts/:id — Suppression définitive
  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePost(@Param('id') id: string) {
    return this.adminService.hardDeletePost(id);
  }
}

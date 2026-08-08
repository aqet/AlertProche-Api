import {
  Controller, Post, Get, Patch, Delete,
  Body, Param, Req, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import { TrustedContactsService } from './trusted-contacts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

class AddContactDto {
  @IsString() contactUserId: string;
}

class RespondInvitationDto {
  @IsString() action: 'accept' | 'reject';
}

@Controller('users/trusted-contacts')
@UseGuards(JwtAuthGuard)
export class TrustedContactsController {
  constructor(private readonly trustedService: TrustedContactsService) {}

  /** GET /users/trusted-contacts — Liste mes personnes de confiance */
  @Get()
  getMyContacts(@Req() req: any) {
    return this.trustedService.getMyContacts(req.user._id.toString());
  }

  /** GET /users/trusted-contacts/pending — Invitations reçues en attente */
  @Get('pending')
  getPendingInvitations(@Req() req: any) {
    return this.trustedService.getPendingInvitations(req.user._id.toString());
  }

  /** POST /users/trusted-contacts — Ajouter une personne de confiance */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  addContact(@Body() dto: AddContactDto, @Req() req: any) {
    return this.trustedService.addContact(req.user._id.toString(), dto.contactUserId);
  }

  /** PATCH /users/trusted-contacts/:inviterId — Accepter ou refuser une invitation */
  @Patch(':inviterId')
  respondToInvitation(
    @Param('inviterId') inviterId: string,
    @Body() dto: RespondInvitationDto,
    @Req() req: any,
  ) {
    return this.trustedService.respondToInvitation(
      req.user._id.toString(),
      inviterId,
      dto.action,
    );
  }

  /** DELETE /users/trusted-contacts/:contactId — Retirer une personne de confiance */
  @Delete(':contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeContact(@Param('contactId') contactId: string, @Req() req: any) {
    return this.trustedService.removeContact(req.user._id.toString(), contactId);
  }

  /** GET /users/trusted-contacts/trusted-by-me — Qui m'a ajouté comme contact de confiance */
  @Get('trusted-by-me')
  getWhoTrustedMe(@Req() req: any) {
    return this.trustedService.getWhoTrustedMe(req.user._id.toString());
  }

  /** DELETE /users/trusted-contacts/leave/:ownerId — Se retirer de la liste de quelqu'un */
  @Delete('leave/:ownerId')
  @HttpCode(HttpStatus.OK)
  leaveTrustedList(@Param('ownerId') ownerId: string, @Req() req: any) {
    return this.trustedService.leaveTrustedList(req.user._id.toString(), ownerId);
  }
}

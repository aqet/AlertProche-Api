import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard JWT optionnel : si un token valide est présent, il est décodé et
 * attaché à req.user. Si absent ou invalide, la requête continue sans user.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  // Surcharge : on ne lève pas d'erreur si l'authentification échoue
  handleRequest(_err: any, user: any) {
    return user ?? null;
  }
}

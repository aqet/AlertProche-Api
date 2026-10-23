import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Garde d'authentification OPTIONNELLE.
 *
 * À la différence de `JwtAuthGuard`, l'absence de jeton (ou un jeton invalide)
 * ne bloque pas la requête : `req.user` reste simplement indéfini et la route
 * est servie en anonyme.
 *
 * Utilisé sur les endpoints publics dont la réponse s'adapte au visiteur
 * (par exemple le fil d'actualités, qui affiche le bouton « Je confirme »
 * déjà coché ou non).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any): any {
    if (err || !user) {
      // Pas de session valide : on laisse passer en anonyme.
      return undefined;
    }
    return user;
  }
}

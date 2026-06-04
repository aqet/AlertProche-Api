import { Injectable, UnprocessableEntityException } from '@nestjs/common';

export interface ModerationResult {
  isClean: boolean;
  reason?: 'lexical' | 'phone' | 'id';
  flaggedWord?: string;
}

@Injectable()
export class ModerationService {
  // Dictionnaire lexical — termes interdits
  private readonly BANNED_WORDS = [
    'idiot', 'imbecile', 'connard', 'salaud', 'ordure', 'batard', 'putain',
    'merde', 'encule', 'fils de pute', 'negre', 'bamboula', 'macaque',
    'sauvage', 'sous-homme', 'tuer', 'assassiner', 'lyncher', 'bruler vif',
    'egorger', 'massacrer', 'exterminer', 'eliminer', 'descendre', 'flinguer',
    'justice populaire', 'faites lui la peau', 'reglement de compte',
    'abruti', 'cretin',
  ];

  // Regex anti-doxxing — numéros de téléphone camerounais
  // private readonly PHONE_PATTERNS = [
  //   /\b(6[5-9]\d{7})\b/,
  //   /\b(2[23]\d{7})\b/,
  //   /\+237\s?\d{8,9}/,
  //   /\b00237\s?\d{8,9}\b/,
  //   /\b\d{3}[\s\-\.]\d{3}[\s\-\.]\d{3,4}\b/,
  // ];

  // Regex anti-doxxing — identifiants officiels
  private readonly ID_PATTERNS = [
    /\b[A-Z]{1,3}\d{6,10}[A-Z]?\b/,
    /passport[e]?\s*:?\s*[A-Z0-9]{6,12}/i,
    /\bcni\s*:?\s*[A-Z0-9]{6,15}\b/i,
  ];

  checkText(text: string): ModerationResult {
    if (!text?.trim()) return { isClean: true };

    const normalized = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // 1. Filtre lexical
    for (const word of this.BANNED_WORDS) {
      if (normalized.includes(word)) {
        return { isClean: false, reason: 'lexical', flaggedWord: word };
      }
    }

    // 2. Filtre anti-doxxing — téléphones
    for (const pattern of this.PHONE_PATTERNS) {
      if (pattern.test(text)) {
        return { isClean: false, reason: 'phone', flaggedWord: 'numéro de téléphone' };
      }
    }

    // 3. Filtre anti-doxxing — identifiants
    for (const pattern of this.ID_PATTERNS) {
      if (pattern.test(text)) {
        return { isClean: false, reason: 'id', flaggedWord: 'identifiant officiel' };
      }
    }

    return { isClean: true };
  }

  getModerationMessage(result: ModerationResult): string {
    switch (result.reason) {
      case 'lexical':
        return `Votre texte contient un terme non autorisé ("${result.flaggedWord}"). Veuillez reformuler votre message.`;
      case 'phone':
        return 'Votre texte contient un numéro de téléphone. Les coordonnées personnelles ne sont pas autorisées.';
      case 'id':
        return 'Votre texte contient un identifiant officiel (CNI, passeport). Ces informations ne sont pas autorisées.';
      default:
        return 'Votre texte contient du contenu non autorisé.';
    }
  }

  /**
   * Vérifie le texte et lève une exception HTTP 422 si non conforme.
   */
  validateOrThrow(text: string): void {
    const result = this.checkText(text);
    if (!result.isClean) {
      throw new UnprocessableEntityException(this.getModerationMessage(result));
    }
  }
}

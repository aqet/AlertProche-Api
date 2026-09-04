import { GoogleGenAI } from '@google/genai';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { throwError } from 'rxjs';

export interface ModerationResult {
  decision: 'APPROVE' | 'BAN';
  confidence: number;
  reasoning: string;
}

// 💡 C'est l'interface stricte qui map tes champs de formulaire
export interface FormCompletionResult {
  publicationType: 'Disparition' | 'Abus' | 'Prevention' | 'Appel à l\'aide' | 'UNKNOWN';
  alertTitle: string;        // ex: "Détresse : Grand-mère Magoubah Madeleine à Yaoundé"
  detailedDescription: string; // Le résumé complet tiré de l'image
  cityName: string;          // La ville extraite (ex: "Yaoundé")
  confidence: number;
}

// 💡 Interface pour le résultat d'analyse audio → formulaire
export interface ParsedAudioAlertDto {
  type: 'Disparition' | 'Abus' | 'Prevention' | "Appel à l'aide" | null;
  title: string | null;
  content: string | null;
  location: string | null;
  isAnonymous: boolean | null;
}

// 💡 Interface pour la validation d'une ville libre
export interface CityValidationResult {
  valid: boolean;
  normalizedName: string | null; // Nom corrigé/normalisé si valide
  reason: string;
}

@Injectable()
export class AiService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  // 💡 Ordre de priorité : on met les modèles économiques/rapides d'abord, puis les plus costauds
  private modelNames = [
    'gemini-2.5-flash-lite', 
    'gemini-2.5-flash',
    'gemini-2.5-flash-tts',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.5-pro',
    'gemini-3-flash' ,
    'gemini-3.5-flash' 
  ];

  // Tableau de failover pour la vision (les modèles Flash actuels)
  private visionModels = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash' ,
    'gemini-3-flash' ,
    'gemini-3.5-flash' 
  ];
 
  async moderateContent(postContent: string, reportReason?: string): Promise<ModerationResult> {
    // 💡 On boucle sur chaque modèle disponible dans notre liste
    for (const model of this.modelNames) {
      try {
        console.log(`[IA MODERATION] Tentative d'analyse avec le modèle : ${model}`);

        const response = await this.ai.models.generateContent({
          model: model, // 👈 Attribution dynamique du modèle
          contents: `Contenu du post à analyser : "${postContent}"\nRaison invoquée pour le signalement : "${reportReason || 'Non précisé'}"`,
          config: {
            systemInstruction: `Tu es un expert en modération pour une plateforme citoyenne de sécurité et de recherche de personnes. 
            Analyse si le contenu viole les règles (haine, faux signalement, harcèlement, contenu inapproprié).
            Tu devez obligatoirement répondre sous format JSON contenant exactement ces trois clés :
            - "decision" : (valeur stricte : "APPROVE" si le post est correct, ou "BAN" s'il doit être suspendu).
            - "confidence" : (un nombre décimal entre 0.0 et 1.0 indiquant ton niveau de certitude).
            - "reasoning" : (une courte phrase en français expliquant ton choix).`,
            
            responseMimeType: 'application/json',
          },
        });

        if (!response.text) {
          throw new Error(`Réponse vide reçue du modèle ${model}`);
        }

        // Si tout s'est bien passé, on parse et on retourne immédiatement le résultat
        const result: ModerationResult = JSON.parse(response.text);
        console.log(`✅ Succès avec le modèle ${model}`);
        return result;

      } catch (error: any) {
        // En cas d'erreur (Quota 429, Modèle introuvable 404, Panne 503...)
        console.warn(`⚠️ Échec avec le modèle ${model}. Code erreur : ${error.status || error.message}. Passage au modèle suivant...`);
        
        // La boucle continue automatiquement vers le modèle suivant du tableau
      }
    }

    // 🛡️ Si TOUS les modèles de la liste ont échoué, on applique le fallback de sécurité final
    console.error('❌ CRITIQUE : Tous les modèles Gemini ont échoué ou ont dépassé leurs quotas.');
    return {
      decision: 'APPROVE',
      confidence: 0.0,
      reasoning: 'Échec technique général de tous les modèles IA, arbitrage humain obligatoire.',
    };
  }

  async autocompleteFormFromImage(imageBase64: string, mimeType: string): Promise<FormCompletionResult> {
    
    // Préparation de l'image pour le SDK Google
    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: mimeType
      },
    };

    // Boucle de bascule automatique (Failover)
    for (const model of this.visionModels) {
      try {
        console.log(`[IA FORM COMPLETION] Tentative avec le modèle : ${model}`);

        const response = await this.ai.models.generateContent({
          model: model,
          // 💡 On passe l'image ET une instruction claire
          contents: [
            imagePart,
            "Analyse cette image d'alerte et extrait les informations pour remplir le formulaire de signalement. Le texte est intégré à l'image, lis-le attentivement."
          ],
          config: {
            systemInstruction: `Tu es un assistant de saisie d'alertes citoyennes pour une plateforme de sécurité. 
            Analyse l'image (photo + texte intégré) et extrait les données sous format JSON strict avec exactement ces clés et types :
            - "publicationType" : (valeur stricte : 'Disparition', 'Abus', 'Prevention', 'Appel à l\'aide' ou "UNKNOWN". Choisis la catégorie la plus pertinente).
            - "alertTitle" : Une phrase d'accroche résumant l'urgence (Maximum 150 caractères).
            - "detailedDescription" : Un résumé textuel complet et cohérent de la situation, reprenant le nom des personnes, l'action, l'urgence et les détails géographiques.
            - "cityName" : Le nom précis de la ville ou commune principale mentionnée. Si plusieurs, choisis la principale. Si aucune, écris "".
            - "confidence" : Ton score de certitude global entre 0.0 et 1.0.`,
            
            responseMimeType: 'application/json',
          },
        });

        if (!response.text) throw new Error(`Réponse vide du modèle visuel ${model}`);

        const result: FormCompletionResult = JSON.parse(response.text);
        console.log(`✅ Autocomplétion réussie avec ${model} (Ville détectée : ${result.cityName})`);
        return result;

      } catch (error: any) {
        console.warn(`⚠️ Échec visuel avec le modèle ${model}. Code : ${error.status || error.message}. Passage au suivant...`);
      }
    }

    // Fallback de sécurité ultime si tout échoue
    console.error('❌ Échec critique : Tous les modèles de vision ont échoué.');
    return {
      publicationType: 'UNKNOWN',
      alertTitle: '',
      detailedDescription: 'Analyse automatique indisponible. Veuillez remplir le formulaire manuellement.',
      cityName: '',
      confidence: 0.0
    };
  }

  /**
   * Génère un texte de notification push pour inciter une mise à jour de l'app.
   * Retourne { title, body } - total ≤ 110 caractères.
   * Fallback automatique si Gemini échoue.
   */
  async generateUpdateNotificationText(): Promise<{ title: string; body: string }> {
    const FALLBACK = {
      title: '🔄 Mise à jour disponible',
      body: 'Nouvelles fonctionnalités et corrections de sécurité vous attendent !',
    };

    const prompt = `Génère un titre et un corps de notification push mobile très court, fluide et incitatif
(maximum 110 caractères au total, titre + corps combinés) pour rappeler à un utilisateur de mettre à jour
son application de sécurité citoyenne afin de profiter des nouvelles fonctionnalités et corrections.
Sois engageant. Réponds UNIQUEMENT en JSON avec les clés "title" et "body". Exemple :
{"title":"🆕 Mise à jour dispo !","body":"Nouvelles fonctionnalités de sécurité vous attendent."}`;

    for (const model of this.modelNames) {
      try {
        const response = await this.ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        if (!response.text) continue;
        const parsed = JSON.parse(response.text);
        if (parsed.title && parsed.body) {
          console.log(`✅ Notification update générée avec ${model}`);
          return { title: parsed.title, body: parsed.body };
        }
      } catch (err: any) {
        console.warn(`⚠️ generateUpdateNotificationText échec avec ${model}: ${err?.message}`);
      }
    }

    console.warn('⚠️ generateUpdateNotificationText : fallback activé.');
    return FALLBACK;
  }

  /**
   * Valide si un nom de ville/localité appartient au Cameroun.
   * Retourne le nom normalisé si valide, sinon valid=false.
   */
  async validateCameroonCity(cityName: string): Promise<CityValidationResult> {
    const FALLBACK: CityValidationResult = {
      valid: false,
      normalizedName: null,
      reason: 'Impossible de valider la ville pour le moment.',
    };

    const prompt = `Est-ce que "${cityName}" est une ville, commune, quartier ou localité réelle située au Cameroun ?
Réponds UNIQUEMENT avec un objet JSON contenant exactement ces clés :
- "valid": true si la localité existe au Cameroun, false sinon.
- "normalizedName": le nom correctement orthographié et accentué si valid=true, null sinon.
- "reason": une courte phrase en français expliquant ta réponse.`;

    for (const model of this.modelNames) {
      try {
        const response = await this.ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        if (!response.text) continue;
        const result: CityValidationResult = JSON.parse(response.text);
        console.log(`✅ Validation ville "${cityName}" avec ${model}: ${result.valid}`);
        return result;
      } catch (err: any) {
        console.warn(`⚠️ validateCity échec avec ${model}: ${err?.message}`);
      }
    }

    return FALLBACK;
  }

  /**
   * Valide si une ville saisie librement est une localité camerounaise.
   * Retourne { valid, normalizedName }.
   */
  async validateCityName(city: string): Promise<{ valid: boolean; normalizedName: string | null }> {
    const FALLBACK = { valid: false, normalizedName: null };

    const prompt = `L'utilisateur a saisi "${city}" comme localisation dans une application de sécurité au Cameroun.
Est-ce une ville, commune, arrondissement ou localité réellement existant au Cameroun ?
Si oui, donne son nom normalisé (en minuscules, sans fautes, orthographe officielle française).
Réponds UNIQUEMENT avec un objet JSON : {"valid": true|false, "normalizedName": "nom normalisé" | null}`;

    for (const model of this.modelNames) {
      try {
        const response = await this.ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        if (!response.text) continue;
        const result = JSON.parse(response.text);
        if (typeof result.valid === 'boolean') {
          console.log(`✅ validateCityName "${city}" → valid=${result.valid} via ${model}`);
          return result;
        }
      } catch (err: any) {
        console.warn(`⚠️ validateCityName échec avec ${model}: ${err?.message}`);
      }
    }
    return FALLBACK;
  }

  /**
   * Analyse un buffer audio et extrait les données pour pré-remplir le formulaire d'alerte.
   * L'audio est traité uniquement en mémoire — aucun fichier n'est créé sur le disque.
   */
  async parseAudioToForm(audioBuffer: Buffer, mimeType: string): Promise<ParsedAudioAlertDto> {
    const FALLBACK: ParsedAudioAlertDto = {
      type: null,
      title: null,
      content: null,
      location: null,
      isAnonymous: null,
    };

    const audioPart = {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType,
      },
    };

    const systemInstruction = `Tu es un assistant d'extraction de données pour une application de sécurité d'urgence au Cameroun.
Écoute cet extrait audio et extrais toutes les informations pertinentes pour remplir une fiche d'alerte citoyenne.
Ignore les bruits de fond, les hésitations ("euh", "hm") et les répétitions.
Réponds EXCLUSIVEMENT avec un objet JSON valide contenant exactement ces clés :
- "type" : Le type de signalement parmi : "Disparition", "Abus", "Prevention", "Appel à l'aide". Si incertain, choisis le plus proche ou null.
- "title" : Un titre d'alerte clair et percutant (maximum 150 caractères). Commence par "URGENT – " si la situation est grave. null si impossible.
- "content" : La description complète et détaillée de la situation (noms, âge, description physique, vêtements, lieu, heure, circonstances). null si impossible.
- "location" : La ville ou région camerounaise mentionnée (ex: "Yaoundé", "Douala", "Bafoussam"). null si non mentionnée.
- "isAnonymous" : true si la personne exprime le souhait de rester anonyme, false sinon, null si non précisé.
Si une information est absente ou incertaine, indique null pour ce champ.`;

    // Modèles avec support audio multimodal (Flash uniquement)
    const audioModels = [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash-lite',
    ];

    for (const model of audioModels) {
      try {
        console.log(`[IA AUDIO] Tentative d'analyse avec le modèle : ${model}`);

        const response = await this.ai.models.generateContent({
          model,
          contents: [audioPart, 'Analyse cet audio et extrais les informations pour le formulaire d\'alerte.'],
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
          },
        });

        if (!response.text) throw new Error(`Réponse vide du modèle ${model}`);

        const result: ParsedAudioAlertDto = JSON.parse(response.text);
        console.log(`✅ Audio analysé avec succès via ${model}`);
        return result;
      } catch (error: any) {
        console.warn(`⚠️ Échec audio avec ${model}: ${error?.status || error?.message}. Passage au suivant...`);
      }
    }

    console.error('❌ Tous les modèles audio ont échoué — retour du fallback vide.');
    return FALLBACK;
  }

  async generateImageEmbedding(imageBase64: string, mimeType: string): Promise<number[]> {    try {
      console.log(`[IA EMBEDDING] Calcul de la signature vectorielle de la photo...`);

      const response = await this.ai.models.embedContent({
        model: 'gemini-embedding-2', // Le modèle multimodal de Google dédié aux vecteurs
        contents: [
          {
            inlineData: {
              data: imageBase64,
              mimeType: mimeType,
            },
          },
        ],
      });

      if (!response.embeddings || !response.embeddings.values) {
        throw new Error("L'API Google n'a retourné aucun vecteur valide.");
      }

      // Renvoie le tableau brut de 1408 nombres décimaux
      console.log("🚀 NOMBRE DE DIMENSIONS REÇU :", response.embeddings[0].values.length);
      return response.embeddings[0].values;

    } catch (error: any) {
      console.error(`❌ Échec du calcul de l'embedding :`, error.message);
      throw new InternalServerErrorException("Impossible d'analyser l'empreinte visuelle de l'image.");
  }
  }
}
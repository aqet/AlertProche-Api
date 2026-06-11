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

  async generateImageEmbedding(imageBase64: string, mimeType: string): Promise<number[]> {
    try {
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
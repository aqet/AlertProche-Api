import { GoogleGenAI } from '@google/genai';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { throwError } from 'rxjs';
import * as puppeteer from 'puppeteer-core';
import * as fs from 'fs';
import * as path from 'path';

export interface ModerationResult {
  decision: 'APPROVE' | 'BAN';
  confidence: number;
  reasoning: string;
}

// 💡 C'est l'interface stricte qui map tes champs de formulaire
export interface FormCompletionResult {
  publicationType: 'Disparition' | 'Abus' | 'Prevention' | 'Appel à l\'aide' | 'UNKNOWN';
  alertTitle: string;
  detailedDescription: string;
  cityName: string;
  confidence: number;
  insufficientData?: boolean; // true si l'image ne contient pas assez d'infos
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
    'gemini-3-flash',
    'gemini-3.5-flash'
  ];

  // Tableau de failover pour la vision (les modèles Flash actuels)
  private visionModels = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
    'gemini-3-flash',
    'gemini-3.5-flash'
  ];

  async moderateContent(postContent: string, reportReason?: string, postType?: string): Promise<ModerationResult> {
    // 💡 On boucle sur chaque modèle disponible dans notre liste
    for (const model of this.modelNames) {
      try {
        console.log(`[IA MODERATION] Tentative d'analyse avec le modèle : ${model}`);

        const response = await this.ai.models.generateContent({
          model: model, // 👈 Attribution dynamique du modèle
          contents: `Type de signalement : "${postType || 'Non précisé'}"\nContenu du post à analyser : "${postContent}"\nRaison invoquée pour le signalement : "${reportReason || 'Non précisé'}"`,
          config: {
            systemInstruction: `Tu es un modérateur expert pour AlertProche, une plateforme citoyenne de sécurité et de recherche de personnes au Cameroun.

CONTEXTE IMPORTANT : Cette plateforme sert à signaler des faits réels (agressions, disparitions, abus, violences) pour alerter la communauté et aider les victimes. Les descriptions de violence, blessures, agressions ou abus sur mineurs sont NORMALES et ATTENDUES car ce sont des témoignages citoyens factuels. Un signalement qui décrit une agression au couteau, des coups, des violences sexuelles ou des sévices sur enfant doit être APPROUVÉ car c'est précisément le but de la plateforme.

Tu dois approuver SAUF si le contenu est :
- De la haine raciale, ethnique ou religieuse (incitation à la haine)
- Du harcèlement ciblé contre une personne nommée sans rapport avec un fait réel
- De la désinformation manifeste ou un canular évident
- Du contenu sexuel explicite non lié à un signalement d'abus
- De la publicité ou du spam déguisé

Tu dois APPROUVER :
- Les descriptions de violences physiques (coups, armes, blessures) car ce sont des faits rapportés
- Les signalements d'abus sur mineurs, même explicites, car c'est une alerte de protection
- Les récits d'agression sexuelle car les victimes ont besoin d'être entendues
- Tout témoignage factuel même choquant, tant qu'il relate un événement réel

Réponds UNIQUEMENT en JSON avec exactement ces trois clés :
- "decision" : "APPROVE" ou "BAN"
- "confidence" : nombre décimal entre 0.0 et 1.0
- "reasoning" : courte phrase en français expliquant ton choix`,

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
            - "alertTitle" : Une phrase d'accroche résumant l'urgence (Maximum 150 caractères). Chaine vide "" si impossible.
            - "detailedDescription" : Un résumé textuel complet et cohérent de la situation. Chaine vide "" si impossible.
            - "cityName" : Le nom précis de la ville ou commune principale mentionnée. Chaine vide "" si aucune.
            - "confidence" : Ton score de certitude global entre 0.0 et 1.0.
            - "insufficientData" : true si l'image est une photo ordinaire sans texte ni information d'alerte (paysage, selfie, objet, photo personnelle), false sinon.
            Si l'image ne contient pas de texte lisible ni d'éléments d'alerte, mets insufficientData à true et laisse les autres champs vides.`,

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

    const prompt = `Est-ce que "${cityName}" est une ville, commune, quartier ou localité réelle dans le monde ?
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

    const prompt = `L'utilisateur a saisi "${city}" comme localisation dans une application de sécurité.
Est-ce une ville, commune, arrondissement ou localité réellement existant dans le monde ?
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
   * L'audio est traité uniquement en mémoire - aucun fichier n'est créé sur le disque.
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

    const systemInstruction = `Tu es un assistant d'extraction de données pour une application de sécurité d'urgence.
Écoute cet extrait audio et extrais toutes les informations pertinentes pour remplir une fiche d'alerte citoyenne.
Ignore les bruits de fond, les hésitations ("euh", "hm") et les répétitions.
Réponds EXCLUSIVEMENT avec un objet JSON valide contenant exactement ces clés :
- "type" : Le type de signalement parmi : "Disparition", "Abus", "Prevention", "Appel à l'aide". Si incertain, choisis le plus proche ou null.
- "title" : Un titre d'alerte clair et percutant (maximum 150 caractères). Commence par "URGENT – " si la situation est grave. null si impossible.
- "content" : La description complète et détaillée de la situation (noms, âge, description physique, vêtements, lieu, heure, circonstances). null si impossible.
- "location" : La ville ou région du monde mentionnée (ex: "Yaoundé", "Hong Kong", "Doubaille"). null si non mentionnée.
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

    console.error('❌ Tous les modèles audio ont échoué - retour du fallback vide.');
    return FALLBACK;
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

  /**
   * Génère une image illustrant une alerte citoyenne.
   * Stratégie : gemini-2.5-flash génère une affiche HTML/CSS,
   * Puppeteer la rend en PNG (1080×1080).
   * Retourne un Buffer PNG ou null si tout échoue (non bloquant).
   */
  async generatePostImage(post: {
    title: string;
    type: string;
    location: string;
    content: string;
    imageBase64?: string;
    mimeType?: string;
  }): Promise<Buffer | null> {

    // ── Étape 1 : demander à Gemini de générer le HTML de l'affiche ──────
    let html = '';
    const cfg = this.typeConfig(post.type);
    const c = this.COLORS;
    const htmlPrompt = `Tu es un designer expert. Génère uniquement le code HTML avec CSS inline d'une affiche d'alerte 1080x1080px pour AlertProche.

Données de l'alerte :
- Type : ${cfg.label}
- Titre : "${post.title}"
- Ville : ${post.location}
- Description : ${post.content.slice(0, 250)}

Design system AlertProche a respecter strictement :
- Couleur principale de l'app : #2E8B4A (vert)
- Fond de page : #F5F6F6
- Fond de carte : #FFFFFF
- Texte principal : #1B1E1D
- Texte secondaire : #5A615C
- Couleur accent du type "${cfg.label}" : ${cfg.accent} (utilise cette couleur pour le badge du type, les accents et les elements importants)
- Fond tinte pour ce type : ${cfg.bg}
- Header et footer : fond #1B5232 (vert fonce AlertProche), texte blanc

Structure de l'affiche :
1. Barre fine de couleur ${cfg.accent} tout en haut (10px)
2. Header fond #1B5232 avec le nom "AlertProche" a gauche et un badge "${cfg.label}" a droite avec couleur ${cfg.accent}
3. Zone centrale fond #F5F6F6 avec le titre en grand, la description, et la ville dans une pilule coloree ${cfg.accent}
4. Footer fond #1B5232 avec "alertproche.com" à gauche et "Sécurité Citoyenne" à droite
- Pas de tiret cadratin, pas d'emoji, pas d'accent HTML encode bizarrement
- Pour la localisation, utilise une icone SVG de pin (path: M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z) plutot qu un emoji
- Police : system-ui, sans-serif
- Pas d'images externes

Contraintes strictes :
- Retourne UNIQUEMENT le code HTML, sans balise \`\`\`html
- Commence directement par <!DOCTYPE html>
- Body : width:1080px; height:1080px; overflow:hidden; margin:0; position:relative`;

    const textModels = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

    for (const model of textModels) {
      try {
        console.log(`[IA HTML GEN] Génération du HTML avec ${model}...`);
        const response = await this.ai.models.generateContent({
          model,
          contents: htmlPrompt,
        });
        const raw = response.text ?? '';
        // Extraire le HTML proprement (enlever les blocs ```html si présents)
        const match = raw.match(/<!DOCTYPE html>[\s\S]*/i);
        html = match ? match[0] : raw;
        if (html.includes('<body')) {
          console.log(`✅ HTML généré via ${model} (${html.length} chars)`);
          break;
        }
      } catch (err: any) {
        console.warn(`⚠️ Échec HTML avec ${model}: ${err?.message}`);
      }
    }

    // Fallback HTML intégré si Gemini échoue aussi
    if (!html.includes('<body')) {
      console.warn('⚠️ Gemini HTML échoué, utilisation du template fallback');
      html = this.buildFallbackHtml(post);
    } else {
      // Injecter le bandeau IA dans le HTML généré par Gemini
      html = this.injectAiBadge(html);
    }

    // ── Étape 2 : rendre le HTML en PNG via Puppeteer ────────────────────
    try {
      const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

      const screenshot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: 1080, height: 1080 },
      });

      await browser.close();
      const buffer = Buffer.isBuffer(screenshot) ? screenshot : Buffer.from(screenshot);
      console.log(`✅ PNG généré via Puppeteer (${buffer.length} bytes)`);
      return buffer;

    } catch (err: any) {
      console.error(`❌ Échec rendu Puppeteer: ${err?.message}`);
      return null;
    }
  }

  /** Charge le logo AlertProche en base64 une seule fois au démarrage */
  private readonly LOGO_B64: string = (() => {
    try {
      // Le fichier logo_b64.txt est généré au build ou présent dans le repo
      const p = path.join(process.cwd(), 'logo_b64.txt');
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    } catch { /* ignoré */ }
    return ''; // pas de logo si le fichier est absent
  })();

  // ── Couleurs du design system AlertProche ──────────────────────
  private readonly COLORS = {
    green: '#2E8B4A',
    greenDark: '#1B5232',
    greenPale: '#E9F2EC',
    bg: '#F5F6F6',
    surface: '#FFFFFF',
    text: '#1B1E1D',
    textSub: '#5A615C',
    urgent: '#E53935',
    urgentDim: 'rgba(229,57,53,0.08)',
    warning: '#F57C00',
    warningDim: 'rgba(245,124,0,0.08)',
    prevention: '#1565C0',
    prevDim: 'rgba(21,101,192,0.08)',
    appel: '#C2185B',
    appelDim: 'rgba(194,24,91,0.08)',
  };

  /** Config par type d'alerte : couleur principale, fond, label */
  private typeConfig(type: string): { accent: string; bg: string; label: string } {
    const c = this.COLORS;
    const map: Record<string, { accent: string; bg: string; label: string }> = {
      'Disparition': { accent: c.urgent, bg: c.urgentDim, label: 'DISPARITION' },
      'Abus': { accent: c.warning, bg: c.warningDim, label: 'ABUS' },
      'Prevention': { accent: c.prevention, bg: c.prevDim, label: 'PREVENTION' },
      "Appel à l'aide": { accent: c.appel, bg: c.appelDim, label: "APPEL A L'AIDE" },
    };
    return map[type] ?? { accent: c.green, bg: c.greenPale, label: type.toUpperCase() };
  }

  /** Bandeau SYNTHESE IA  INFORMATION en bas de l'image */
  private readonly AI_BADGE_STYLE = `
  .ai-badge {
    position: absolute;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(27, 30, 29, 0.80);
    color: #E9F2EC;
    font-family: 'Outfit', system-ui, sans-serif;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 3px;
    text-transform: uppercase;
    padding: 13px 38px;
    border-radius: 50px;
    border: 1.5px solid rgba(255,255,255,0.15);
    backdrop-filter: blur(8px);
    white-space: nowrap;
    box-shadow: 0 4px 20px rgba(0,0,0,0.30);
    z-index: 999;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ai-badge .sep {
    width: 5px; height: 5px;
    background: #6FAE89;
    border-radius: 50%;
    display: inline-block;
  }`;

  private readonly AI_BADGE_HTML =
    `<div class="ai-badge">SYNTHESE IA<span class="sep"></span>INFORMATION</div>`;

  /** Injecte le bandeau dans un HTML généré par Gemini */
  private injectAiBadge(html: string): string {
    html = html.replace('</style>', `${this.AI_BADGE_STYLE}\n  </style>`);
    // S'assurer que body a position:relative pour le badge absolu
    html = html.replace(/body\s*\{/g, 'body { position: relative;');
    html = html.replace('</body>', `  ${this.AI_BADGE_HTML}\n</body>`);
    return html;
  }

  /** Template HTML propre aux couleurs AlertProche */
  private buildFallbackHtml(
    post: { title: string; type: string; location: string; content: string },
  ): string {
    const cfg = this.typeConfig(post.type);
    const c = this.COLORS;
    const logo = this.LOGO_B64;
    const safe = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const desc = safe(post.content.slice(0, 180));
    const title = safe(post.title);
    const loc = safe(post.location);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    position: relative;
    width: 1080px; height: 1080px; overflow: hidden;
    background: ${c.surface};
    font-family: 'Outfit', system-ui, sans-serif;
    color: ${c.text};
    display: flex; flex-direction: column;
  }

  /* Bande de couleur type en haut */
  .top-bar {
    background: ${cfg.accent};
    height: 10px;
    width: 100%;
    flex-shrink: 0;
  }

  /* Header : fond vert sombre AlertProche */
  .header {
    background: ${c.greenDark};
    padding: 30px 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .header-brand {
    display: flex; align-items: center; gap: 18px;
  }
  .header-logo {
    width: 150px; height: 150px; object-fit: contain;
  }
  .header-name {
    font-size: 34px; font-weight: 900;
    color: #fff; letter-spacing: 0.5px;
  }
  .header-name span { color: ${c.green}; }

  /* Badge type */
  .type-badge {
    background: ${cfg.bg};
    color: ${cfg.accent};
    border: 2px solid ${cfg.accent};
    border-radius: 50px;
    padding: 10px 32px;
    font-size: 22px; font-weight: 800;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  /* Corps principal */
  .main {
    flex: 1;
    background: ${c.bg};
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    padding: 52px 72px;
    gap: 36px;
    text-align: center;
  }

  /* Trait coloré accent */
  .accent-bar {
    width: 80px; height: 6px;
    background: ${cfg.accent};
    border-radius: 3px;
  }

  .title {
    font-size: 48px; font-weight: 900;
    color: ${c.text}; line-height: 1.15;
    max-width: 880px;
  }
  .desc {
    font-size: 26px; font-weight: 400;
    color: ${c.textSub}; line-height: 1.6;
    max-width: 860px;
  }

  /* Localisation */
  .location-pill {
    background: ${cfg.accent};
    color: #fff;
    border-radius: 50px;
    padding: 16px 44px;
    font-size: 28px; font-weight: 700;
    letter-spacing: 0.5px;
    display: flex; align-items: center; gap: 14px;
  }
  .pin-icon { width: 28px; height: 28px; flex-shrink: 0; fill: #fff; }

  /* Footer */
  .footer {
    background: ${c.greenDark};
    padding: 22px 52px;
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }
  .footer-text {
    font-size: 20px; color: rgba(255,255,255,0.55);
    letter-spacing: 0.3px;
  }
  .footer-tag {
    font-size: 18px; color: ${c.green};
    font-weight: 600;
  }

  ${this.AI_BADGE_STYLE}
</style>
</head>
<body>
  <div class="top-bar"></div>

  <div class="header">
    <div class="header-brand">
      ${logo ? `<img class="header-logo" src="${logo}" alt="Logo AlertProche">` : ''}
      <span class="header-name">Alert<span>Proche</span></span>
    </div>
    <div class="type-badge">${safe(cfg.label)}</div>
  </div>

  <div class="main">
    <div class="accent-bar"></div>
    <div class="title">${title}</div>
    <div class="desc">${desc}</div>
    <div class="location-pill">
      <svg class="pin-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
      </svg>
      ${loc}
    </div>
  </div>

  <div class="footer">
    <span class="footer-text">alertproche.com</span>
    <span class="footer-tag">Sécurité Citoyenne</span>
  </div>

  ${this.AI_BADGE_HTML}
</body>
</html>`;
  }

  /**
   * Reformule les infos d'un post d'alerte en une courte légende naturelle pour le feed.
   * Ex: "Un enfant de 8 ans a disparu hier soir à Yaoundé. Toute information est utile."
   */
  async generateFeedCaption(post: {
    title: string;
    type: string;
    location: string;
    content: string;
  }): Promise<string> {
    const prompt = `Tu es un rédacteur pour une application de sécurité citoyenne au Cameroun.
Reformule cette alerte en une seule phrase courte et naturelle (maximum 160 caractères) pour un fil d'actualité social.
Sois factuel et sobre.
Interdictions strictes : pas d'emoji, pas de hashtag, pas de tiret cadratin (ni —, ni –), pas de formatage Markdown, pas de guillemets.

Type : ${post.type}
Titre : ${post.title}
Ville : ${post.location}
Contenu : ${post.content.slice(0, 300)}

Réponds UNIQUEMENT avec la phrase, rien d'autre.`;

    const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'];

    for (const model of models) {
      try {
        const response = await this.ai.models.generateContent({ model, contents: prompt });
        let text = (response.text ?? '').trim().replace(/^["']|["']$/g, '');
        // Nettoyage défensif : tirets cadratins, emojis, hashtags
        text = text
          .replace(/[—–]/g, '-')          // tirets cadratins → tiret simple
          .replace(/#\w+/g, '')            // hashtags
          .replace(/[\u{1F300}-\u{1FAFF}]/gu, '') // emojis unicode
          .replace(/\s{2,}/g, ' ')         // doubles espaces
          .trim();
        if (text.length > 10) {
          console.log(`✅ Caption feed générée via ${model}`);
          return text.slice(0, 200);
        }
      } catch (err: any) {
        console.warn(`⚠️ generateFeedCaption échec ${model}: ${err?.message}`);
      }
    }

    // Fallback simple si tous les modèles échouent
    return `${post.type} signale a ${post.location}. ${post.title}`.slice(0, 200);
  }

  /**
   * Génère une réponse de chat avec le contexte conversationnel.
   * Utilisé par le chatbot assistant AlertProche.
   */
  async generateChatResponse(
    contents: { role: string; parts: { text: string }[] }[],
    systemInstruction: string,
  ): Promise<string> {
    const chatModels = [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.0-flash',
    ];

    for (const model of chatModels) {
      try {
        console.log(`[CHAT] Tentative avec le modèle : ${model}`);
        const response = await this.ai.models.generateContent({
          model,
          contents: contents as any,
          config: { systemInstruction },
        });
        const text = response.text ?? '';
        if (text) {
          console.log(`✅ Chat réponse via ${model}`);
          return text;
        }
      } catch (err: any) {
        console.warn(`⚠️ Chat échec ${model}: ${err?.message}`);
      }
    }

    console.error('❌ Tous les modèles chat ont échoué.');
    return '';
  }
}
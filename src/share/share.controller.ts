import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { PostsService } from '../posts/posts.service';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://alert-proche.vercel.app';
const SITE_NAME    = 'AlertProche';
const SITE_SLOGAN  = 'Protéger les personnes vulnérables, c\'est l\'affaire de tous.';
const FALLBACK_IMG = `${FRONTEND_URL}/favicon.ico`;

const TYPE_EMOJI: Record<string, string> = {
  'Disparition':    '🚨',
  'Abus':           '⚠️',
  'Prevention':     'ℹ️',
  "Appel à l'aide": '🆘',
};

@Controller('share')
export class ShareController {
  constructor(private readonly postsService: PostsService) {}

  /**
   * GET /share/posts/:id
   * Retourne une page HTML minimaliste avec meta OG complets.
   * Les crawlers WhatsApp / Facebook / Telegram / iMessage lisent cette page.
   * Les vrais navigateurs sont immédiatement redirigés vers l'app Angular.
   */
  @Get('posts/:id')
  async sharePost(@Param('id') id: string, @Res() res: Response) {
    try {
      const post = await this.postsService.findOne(id);
      const postUrl  = `${FRONTEND_URL}/posts/${id}`;
      const shareUrl = `${process.env.API_URL || 'https://alert-proche-api.vercel.app'}/share/posts/${id}`;
      const image    = post.image_url || FALLBACK_IMG;
      const emoji    = TYPE_EMOJI[post.type] || '📢';

      const title       = `${emoji} ${post.title}`;
      const description = `${post.type} — ${post.location}\n${post.content.slice(0, 200).replace(/\n/g, ' ')}…`;
      const safeTitle   = this.escape(title);
      const safeDesc    = this.escape(description);
      const safeImage   = this.escape(image);
      const safePostUrl = this.escape(postUrl);
      const safeShareUrl = this.escape(shareUrl);

      const html = `<!DOCTYPE html>
<html lang="fr" prefix="og: https://ogp.me/ns#">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle} — ${SITE_NAME}</title>

  <!-- ── Open Graph (Facebook, WhatsApp, Telegram, LinkedIn) ─── -->
  <meta property="og:type"         content="article">
  <meta property="og:site_name"    content="${SITE_NAME}">
  <meta property="og:title"        content="${safeTitle}">
  <meta property="og:description"  content="${safeDesc}">
  <meta property="og:image"        content="${safeImage}">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt"    content="${safeTitle}">
  <meta property="og:url"          content="${safePostUrl}">
  <meta property="og:locale"       content="fr_CM">

  <!-- ── Twitter Card ──────────────────────────────────────── -->
  <meta name="twitter:card"        content="${post.image_url ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:site"        content="@AlertProche">
  <meta name="twitter:title"       content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image"       content="${safeImage}">

  <!-- ── SEO de base ───────────────────────────────────────── -->
  <meta name="description"         content="${safeDesc}">
  <meta name="robots"              content="noindex, follow">

  <!-- ── Redirection immédiate pour les vrais navigateurs ──── -->
  <meta http-equiv="refresh" content="0; url=${safePostUrl}">
  <link rel="canonical" href="${safePostUrl}">

  <style>
    body { font-family: system-ui, sans-serif; background: #0a0f1e; color: #fff;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; }
    a    { color: #00d4aa; }
  </style>
</head>
<body>
  <p>Redirection en cours… <a href="${safePostUrl}">Cliquez ici</a> si rien ne se passe.</p>
  <script>window.location.replace(${JSON.stringify(postUrl)});</script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Pas de cache long — le post peut être modifié
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      res.status(200).send(html);

    } catch {
      // Post introuvable → redirection vers l'accueil
      res.redirect(302, `${FRONTEND_URL}`);
    }
  }

  private escape(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

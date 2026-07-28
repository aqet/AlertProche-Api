import { Controller, Get, Res } from '@nestjs/common';
import { AppService } from './app.service';
// import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('/.well-known/assetlinks.json')
  getAssetLinks(@Res() res: Response) {
    res.setHeader('Content-Type', 'application/json');
    res.json([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.alertproche.app', // Remplace par ton package name exact (ex: com.alertproche.app)
          sha256_cert_fingerprints: [
            "A2:D6:A9:8C:9B:4B:C2:74:EB:5B:F6:59:35:5D:65:DD:C6:99:76:F8:57:A5:2A:69:09:61:BD:DD:F0:E3:A8:B6" // Ton empreinte SHA-256
          ]
        }
      }
    ]);
  }
}

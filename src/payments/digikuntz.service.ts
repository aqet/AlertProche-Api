import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosResponse } from 'axios';

export interface DigikuntzTransactionResponse {
  paymentLink: string;
  transactionRef: string;
}

export interface DigikuntzPayoutResponse {
  success: boolean;
  message?: string;
  [key: string]: any;
}

@Injectable()
export class DigikuntzService {
  private readonly logger = new Logger(DigikuntzService.name);

  private readonly baseUrl = process.env.DIGIKUNTZ_BASE_URL ?? 'https://app.digikuntz.com/dev';
  private readonly userId  = process.env.DIGIKUNTZ_USER_ID  ?? '';
  private readonly secretKey = process.env.DIGIKUNTZ_SECRET_KEY ?? '';

  constructor(private readonly http: HttpService) {}

  private get headers(): Record<string, string> {
    return {
      'x-user-id':    this.userId,
      'x-secret-key': this.secretKey,
      'Content-Type': 'application/json',
    };
  }

  async createTransaction(params: {
    amount: number;
    raisonForTransfer: string;
    callbackUrl: string;
    userEmail: string;
    userPhone: string;
    userCountry: string;
    senderName: string;
  }): Promise<DigikuntzTransactionResponse> {
    const url = `${this.baseUrl}/transaction`;
    this.logger.log(`[digiKUNTZ] createTransaction ${params.amount} XAF – ${params.raisonForTransfer}`);

    try {
      const res: AxiosResponse<Record<string, any>> = await firstValueFrom(
        this.http.post<Record<string, any>>(
          url,
          {
            estimation: params.amount,
            raisonForTransfer: params.raisonForTransfer,
            callbackUrl: params.callbackUrl,
            userEmail: params.userEmail,
            userPhone: params.userPhone,
            userCountry: params.userCountry,
            senderName: params.senderName,
          },
          { headers: this.headers },
        ),
      );

      const data = res.data;
      return {
        paymentLink:    data['paymentLink']    ?? data['payment_link']   ?? data['link'] ?? '',
        transactionRef: data['transactionRef'] ?? data['transaction_ref'] ?? data['ref'] ?? `REF-${Date.now()}`,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      this.logger.error(
        `[digiKUNTZ] createTransaction failed: status=${status ?? 'N/A'} message=${err?.message} body=${JSON.stringify(data)}`,
      );
      throw new InternalServerErrorException({
        message: 'Erreur lors de la création de la transaction digiKUNTZ.',
        digikuntzStatus: status,
        digikuntzBody: data,
      });
    }
  }

  async createPayout(
    amount: number,
    accountBankCode: string,
    accountNumber: string,
    receiverName: string,
    narration: string,
  ): Promise<DigikuntzPayoutResponse> {
    const url = `${this.baseUrl}/payout`;
    this.logger.log(`[digiKUNTZ] createPayout ${amount} XAF → ${receiverName}`);

    try {
      const res: AxiosResponse<Record<string, any>> = await firstValueFrom(
        this.http.post<Record<string, any>>(
          url,
          { amount, accountBankCode, accountNumber, receiverName, currency: 'XAF', narration },
          { headers: this.headers },
        ),
      );
      return res.data as DigikuntzPayoutResponse;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      this.logger.error(
        `[digiKUNTZ] createPayout failed: status=${status ?? 'N/A'} message=${err?.message} body=${JSON.stringify(data)}`,
      );
      throw new InternalServerErrorException({
        message: 'Erreur lors du payout digiKUNTZ.',
        digikuntzStatus: status,
        digikuntzBody: data,
      });
    }
  }
}

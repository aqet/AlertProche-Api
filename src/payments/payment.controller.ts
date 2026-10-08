import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Request,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { Post as PostModel, PostDocument } from '../schemas/post.schema';
import { User as UserModel, UserDocument } from '../schemas/user.schema';
import { DigikuntzService } from './digikuntz.service';

@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,

    @InjectModel(PostModel.name)
    private readonly postModel: Model<PostDocument>,

    @InjectModel(UserModel.name)
    private readonly userModel: Model<UserDocument>,

    private readonly digikuntz: DigikuntzService,
  ) {}

  /** Résout les infos client attendues par digiKUNTZ à partir du userId + téléphone saisi. */
  private async resolveCustomer(userId: string | undefined, phone: string) {
    const defaultEmail = process.env.DIGIKUNTZ_DEFAULT_EMAIL ?? 'contact@alertproche.com';
    if (userId) {
      try {
        const user = await this.userModel.findById(userId).lean();
        this.logger.log(`[resolveCustomer] userId=${userId} found=${!!user} email=${user?.email}`);
        if (user) {
          return {
            userEmail: user.email,
            userPhone: phone,
            userCountry: 'Cameroon',
            senderName: user.pseudo,
          };
        }
      } catch (e: any) {
        this.logger.warn(`[resolveCustomer] findById failed for userId=${userId}: ${e?.message}`);
      }
    }
    this.logger.warn(`[resolveCustomer] userId=${userId} → fallback email=${defaultEmail}`);
    return {
      userEmail: defaultEmail,
      userPhone: phone,
      userCountry: 'Cameroon',
      senderName: 'Donateur AlertProche',
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // POST /payments/donations/initiate
  // ──────────────────────────────────────────────────────────────────────
  @Post('donations/initiate')
  @HttpCode(HttpStatus.OK)
  async initiateDonation(
    @Body() body: { alertId: string; amount: number; userId?: string; phone: string },
  ) {
    const { alertId, amount, userId, phone } = body;

    if (!alertId || !amount || amount < 100) {
      throw new BadRequestException('alertId et amount (min 100) sont requis.');
    }
    if (!phone || phone.replace(/\D/g, '').length < 8) {
      throw new BadRequestException('Un numéro de téléphone Mobile Money valide est requis.');
    }

    const alert = await this.postModel.findById(alertId).lean();
    if (!alert) throw new NotFoundException('Alerte introuvable.');

    const appBaseUrl = process.env.APP_BASE_URL ?? 'https://alertproche.com';
    const callbackUrl = `${appBaseUrl}/payments/callback`;

    const customer = await this.resolveCustomer(userId, phone);

    const { paymentLink, transactionRef } = await this.digikuntz.createTransaction({
      amount,
      raisonForTransfer: `Don pour l'alerte : ${alert.title}`,
      callbackUrl,
      userEmail: customer.userEmail,
      userPhone: customer.userPhone,
      userCountry: customer.userCountry,
      senderName: customer.senderName,
    });

    const tx = await this.transactionModel.create({
      userId: userId ? new Types.ObjectId(userId) : undefined,
      alertId: new Types.ObjectId(alertId),
      transactionRef,
      amount,
      currency: 'XAF',
      type: 'DONATION_ALERT',
      status: 'PENDING',
      paymentLink,
    });

    this.logger.log(`Donation initiated: ${tx._id} – ref ${transactionRef}`);
    return { paymentLink, transactionRef, transactionId: tx._id };
  }

  // ──────────────────────────────────────────────────────────────────────
  // POST /payments/support/initiate
  // ──────────────────────────────────────────────────────────────────────
  @Post('support/initiate')
  @HttpCode(HttpStatus.OK)
  async initiateSupport(
    @Body() body: { amount: number; userId?: string; phone: string },
  ) {
    const { amount, userId, phone } = body;

    if (!amount || amount < 100) {
      throw new BadRequestException('amount (min 100) est requis.');
    }
    if (!phone || phone.replace(/\D/g, '').length < 8) {
      throw new BadRequestException('Un numéro de téléphone Mobile Money valide est requis.');
    }

    const appBaseUrl = process.env.APP_BASE_URL ?? 'https://alertproche.com';
    const callbackUrl = `${appBaseUrl}/payments/callback`;

    const customer = await this.resolveCustomer(userId, phone);

    const { paymentLink, transactionRef } = await this.digikuntz.createTransaction({
      amount,
      raisonForTransfer: 'Soutien à la plateforme AlertProche',
      callbackUrl,
      userEmail: customer.userEmail,
      userPhone: customer.userPhone,
      userCountry: customer.userCountry,
      senderName: customer.senderName,
    });

    const tx = await this.transactionModel.create({
      userId: userId ? new Types.ObjectId(userId) : undefined,
      transactionRef,
      amount,
      currency: 'XAF',
      type: 'PLATFORM_SUPPORT',
      status: 'PENDING',
      paymentLink,
    });

    this.logger.log(`Platform support initiated: ${tx._id} – ref ${transactionRef}`);
    return { paymentLink, transactionRef, transactionId: tx._id };
  }

  // ──────────────────────────────────────────────────────────────────────
  // POST /payments/payout/request  (auth requis)
  // ──────────────────────────────────────────────────────────────────────
  @Post('payout/request')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async requestPayout(
    @Request() req: any,
    @Body()
    body: {
      alertId: string;
      amount: number;
      accountBankCode: string;
      accountNumber: string;
      receiverName: string;
    },
  ) {
    const { alertId, amount, accountBankCode, accountNumber, receiverName } = body;

    if (!alertId || !amount || !accountBankCode || !accountNumber || !receiverName) {
      throw new BadRequestException('Tous les champs sont requis.');
    }

    const alert = await this.postModel.findById(alertId).lean();
    if (!alert) throw new NotFoundException('Alerte introuvable.');

    const userId = req.user._id ?? req.user.userId;
    const authorIdStr = alert.author_id?.toString();
    if (authorIdStr !== userId?.toString()) {
      throw new BadRequestException("Vous n'êtes pas l'auteur de cette alerte.");
    }

    const availableAmount = (alert.raisedAmount ?? 0) - (alert.withdrawnAmount ?? 0);
    if (amount > availableAmount) {
      throw new BadRequestException(
        `Montant demandé supérieur au disponible (${availableAmount} XAF).`,
      );
    }

    const tx = await this.transactionModel.create({
      userId: new Types.ObjectId(userId),
      alertId: new Types.ObjectId(alertId),
      transactionRef: `PAYOUT-${Date.now()}-${userId}`,
      amount,
      currency: 'XAF',
      type: 'PAYOUT_REQUEST',
      status: 'PAYOUT_PENDING',
      accountBankCode,
      accountNumber,
      receiverName,
    });

    this.logger.log(`Payout requested: ${tx._id} – ${amount} XAF for alert ${alertId}`);
    return { message: 'Demande de retrait enregistrée, en attente de validation.', transactionId: tx._id };
  }

  // ──────────────────────────────────────────────────────────────────────
  // POST /payments/webhook  (public – appelé par digiKUNTZ)
  // ──────────────────────────────────────────────────────────────────────
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() payload: any) {
    this.logger.log(`digiKUNTZ webhook received: ${JSON.stringify(payload)}`);

    const ref = payload?.transactionRef ?? payload?.transaction_ref ?? payload?.ref;
    const status = payload?.status;

    if (!ref || !status) {
      return { received: true };
    }

    const tx = await this.transactionModel.findOne({ transactionRef: ref });
    if (!tx) {
      this.logger.warn(`Webhook: transaction not found for ref ${ref}`);
      return { received: true };
    }

    const isSuccess = ['SUCCESS', 'success', 'COMPLETED', 'completed'].includes(status);
    const isFailed  = ['FAILED',  'failed',  'CANCELLED', 'cancelled'].includes(status);

    if (isSuccess && tx.status !== 'SUCCESS') {
      tx.status = 'SUCCESS';
      await tx.save();

      if (tx.type === 'DONATION_ALERT' && tx.alertId) {
        await this.postModel.findByIdAndUpdate(tx.alertId, {
          $inc: { raisedAmount: tx.amount },
        });
        this.logger.log(`raisedAmount updated for alert ${tx.alertId} +${tx.amount}`);
      }
    } else if (isFailed && tx.status !== 'FAILED') {
      tx.status = 'FAILED';
      await tx.save();
    }

    return { received: true };
  }

  // ──────────────────────────────────────────────────────────────────────
  // GET /payments/my-cagnottes  (auth requis)
  // ──────────────────────────────────────────────────────────────────────
  @Get('my-cagnottes')
  @UseGuards(JwtAuthGuard)
  async getMyCagnottes(@Request() req: any) {
    const userId = req.user._id ?? req.user.userId;

    const posts = await this.postModel
      .find({ author_id: new Types.ObjectId(userId) })
      .select('title type location targetAmount raisedAmount withdrawnAmount createdAt')
      .lean();

    return posts.map((p: any) => ({
      ...p,
      availableAmount: (p.raisedAmount ?? 0) - (p.withdrawnAmount ?? 0),
    }));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Admin payout approval – monté sur /admin/payments
// ──────────────────────────────────────────────────────────────────────────
@Controller('admin/payments')
export class AdminPaymentController {
  private readonly logger = new Logger(AdminPaymentController.name);

  constructor(
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,

    @InjectModel(PostModel.name)
    private readonly postModel: Model<PostDocument>,

    private readonly digikuntz: DigikuntzService,
  ) {}

  @Post('payout/approve/:transactionId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  @HttpCode(HttpStatus.OK)
  async approvePayout(@Param('transactionId') transactionId: string) {
    const tx = await this.transactionModel.findById(transactionId);
    if (!tx) throw new NotFoundException('Transaction introuvable.');
    if (tx.type !== 'PAYOUT_REQUEST') {
      throw new BadRequestException('Cette transaction ne peut pas être approuvée comme payout.');
    }
    if (tx.status !== 'PAYOUT_PENDING') {
      throw new BadRequestException(`Statut actuel incompatible : ${tx.status}`);
    }

    try {
      const result = await this.digikuntz.createPayout(
        tx.amount,
        tx.accountBankCode!,
        tx.accountNumber!,
        tx.receiverName!,
        `Retrait AlertProche – ${tx.alertId ?? 'plateforme'}`,
      );

      tx.status = 'PAYOUT_SUCCESS';
      await tx.save();

      if (tx.alertId) {
        await this.postModel.findByIdAndUpdate(tx.alertId, {
          $inc: { withdrawnAmount: tx.amount },
        });
      }

      this.logger.log(`Payout approved: ${tx._id} – ${tx.amount} XAF`);
      return { message: 'Payout effectué avec succès.', digikuntz: result };
    } catch (err: any) {
      tx.status = 'PAYOUT_ERROR';
      await tx.save();
      this.logger.error(`Payout failed: ${err?.message}`);
      throw new BadRequestException(`Échec du payout : ${err?.message}`);
    }
  }
}

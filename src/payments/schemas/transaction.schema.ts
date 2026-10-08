import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TransactionDocument = Transaction & Document;

export type TransactionType = 'DONATION_ALERT' | 'PLATFORM_SUPPORT' | 'PAYOUT_REQUEST';
export type TransactionStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'PAYOUT_PENDING'
  | 'PAYOUT_SUCCESS'
  | 'PAYOUT_ERROR';

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  userId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Post', required: false })
  alertId?: Types.ObjectId;

  @Prop({ required: true, type: String })
  transactionRef: string;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ type: String, default: 'XAF' })
  currency: string;

  @Prop({
    type: String,
    enum: ['DONATION_ALERT', 'PLATFORM_SUPPORT', 'PAYOUT_REQUEST'],
    required: true,
  })
  type: TransactionType;

  @Prop({
    type: String,
    enum: ['PENDING', 'SUCCESS', 'FAILED', 'PAYOUT_PENDING', 'PAYOUT_SUCCESS', 'PAYOUT_ERROR'],
    default: 'PENDING',
  })
  status: TransactionStatus;

  @Prop({ type: String, required: false })
  paymentLink?: string;

  @Prop({ type: String, required: false })
  accountBankCode?: string;

  @Prop({ type: String, required: false })
  accountNumber?: string;

  @Prop({ type: String, required: false })
  receiverName?: string;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

TransactionSchema.index({ transactionRef: 1 });
TransactionSchema.index({ userId: 1 });
TransactionSchema.index({ alertId: 1 });
TransactionSchema.index({ status: 1 });
TransactionSchema.index({ createdAt: -1 });

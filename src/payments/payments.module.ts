import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { PaymentController, AdminPaymentController } from './payment.controller';
import { DigikuntzService } from './digikuntz.service';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { Post, PostSchema } from '../schemas/post.schema';
import { User, UserSchema } from '../schemas/user.schema';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuthModule,
  ],
  controllers: [PaymentController, AdminPaymentController],
  providers: [DigikuntzService],
  exports: [DigikuntzService],
})
export class PaymentsModule {}

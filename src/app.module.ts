import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module';
import { PostsModule } from './posts/posts.module';
import { CommentsModule } from './comments/comments.module';
import { ModerationModule } from './common/moderation/moderation.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    // Configuration globale (.env)
    ConfigModule.forRoot({ isGlobal: true }),

    // MongoDB via Mongoose
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 30000,
        tls: config.get<string>('MONGODB_URI')?.includes('mongodb+srv') ? true : false,
      }),
    }),

    // Modules fonctionnels
    AuthModule,
    PostsModule,
    CommentsModule,
    ModerationModule,
    AdminModule,
  ],
})
export class AppModule {}

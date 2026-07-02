import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { TrackingSession, TrackingSessionSchema } from './schemas/tracking-session.schema';
import { TrackingEvent, TrackingEventSchema } from './schemas/tracking-event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TrackingSession.name, schema: TrackingSessionSchema },
      { name: TrackingEvent.name, schema: TrackingEventSchema },
    ]),
  ],
  controllers: [TrackingController],
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}

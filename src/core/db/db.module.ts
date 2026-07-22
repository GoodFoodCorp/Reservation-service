import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DbService } from './db.service';

/** Owns the MongoDB connection for the whole app. */
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27018/reservation_db',
      }),
    }),
  ],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}

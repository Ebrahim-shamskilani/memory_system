import { Global, Module } from '@nestjs/common';
import { ChromadbController } from './chromadb.controller';
import { ChromadbService } from './chromadb.service';

@Global()
@Module({
  controllers: [ChromadbController],
  providers: [ChromadbService],
  exports: [ChromadbService],
})
export class ChromadbModule {}

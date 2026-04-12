import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { StoreIntegrityService } from '../unified-memory/store/store-integrity.service';

async function main() {
  console.log('Bootstrapping NestJS application...');
  const app = await NestFactory.createApplicationContext(AppModule);

  const integrityService = app.get(StoreIntegrityService);

  console.log('\nRunning store sync...\n');
  const result = await integrityService.syncAll();

  console.log('\n=== Sync Results ===');
  for (const [collection, stats] of Object.entries(result.details)) {
    console.log(`  ${collection}: ${stats.synced} synced, ${stats.orphansRemoved} orphans removed`);
  }
  console.log(`\n  Total: ${result.totalSynced} synced, ${result.totalOrphansRemoved} orphans removed`);

  await app.close();
  console.log('\nDone.');
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});

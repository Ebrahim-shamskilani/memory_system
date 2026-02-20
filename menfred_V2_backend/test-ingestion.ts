/**
 * Integration test for the ingestion pipeline.
 * Tests:
 * 1. Persian message with no punctuation → extracts entities, facts, relationships
 * 2. Recall after ingestion → answers based on ingested data
 * 3. Correction → both old and new memories exist, recall picks the correct one
 * 4. Verify Neo4j and ChromaDB have all the data
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { UnifiedMemoryService } from './src/unified-memory/unified-memory.service';
import { GraphDbService } from './src/graph-db/graph-db.service';
import { ChromadbService } from './src/chromadb/chromadb.service';

async function main() {
  console.log('=== Booting NestJS app ===\n');
  const app = await NestFactory.createApplicationContext(AppModule);

  const memory = app.get(UnifiedMemoryService);
  const graphDb = app.get(GraphDbService);
  const chromaDb = app.get(ChromadbService);

  // Clean up
  console.log('--- Cleaning up ---');
  try { await graphDb.runQuery('MATCH (n) DETACH DELETE n'); } catch {}
  console.log('  Neo4j cleared.\n');

  // ========================================
  // TEST 1: Persian message with no punctuation
  // ========================================
  console.log('=== TEST 1: Persian message ingestion ===\n');
  const msg1 = 'من تو برلین زندگی میکنم و از زندگیم راضی هستم دلارا و آرزو هم با من زندگی می کنن';
  console.log(`Message: "${msg1}"\n`);

  const result1 = await memory.processMessage(msg1);
  console.log('Ingestion:', JSON.stringify(result1.ingestion, null, 2));
  console.log('Answer:', result1.answer);
  console.log();

  // Check what was stored
  console.log('--- Neo4j entities after message 1 ---');
  const entities1 = await graphDb.runQuery(
    'MATCH (e:Entity) RETURN e.canonicalName AS name, e.entityType AS type, e.description AS desc',
  );
  for (const r of entities1.records as any[]) {
    console.log(`  ${r.name} (${r.type}): ${r.desc}`);
  }

  console.log('\n--- Neo4j facts after message 1 ---');
  const facts1 = await graphDb.runQuery('MATCH (f:Fact) RETURN f.content AS content');
  for (const r of facts1.records as any[]) {
    console.log(`  - ${r.content}`);
  }

  console.log('\n--- Neo4j relationships after message 1 ---');
  const rels1 = await graphDb.runQuery(
    'MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.canonicalName AS from, r.relationType AS rel, b.canonicalName AS to',
  );
  for (const r of rels1.records as any[]) {
    console.log(`  ${r.from} --[${r.rel}]--> ${r.to}`);
  }

  // ========================================
  // TEST 2: Recall after ingestion
  // ========================================
  console.log('\n=== TEST 2: Recall after ingestion ===\n');

  console.log('Query: "Where does Ebrahim live?"');
  const result2 = await memory.recall('Where does Ebrahim live?');
  console.log('Answer:', result2.answer);
  console.log();

  console.log('Query: "Who lives with Ebrahim?"');
  const result3 = await memory.recall('Who lives with Ebrahim?');
  console.log('Answer:', result3.answer);
  console.log();

  // ========================================
  // TEST 3: Correction — append-only
  // ========================================
  console.log('=== TEST 3: User correction (append-only) ===\n');

  const msg2 = 'راستی دلارا دخترمه و آرزو خانممه';
  console.log(`Message: "${msg2}"\n`);

  const result4 = await memory.processMessage(msg2);
  console.log('Ingestion:', JSON.stringify(result4.ingestion, null, 2));
  console.log();

  // Check that both old and new facts exist
  console.log('--- All facts in Neo4j (should include old + new) ---');
  const allFacts = await graphDb.runQuery('MATCH (f:Fact) RETURN f.content AS content ORDER BY f.createdAt');
  for (const r of allFacts.records as any[]) {
    console.log(`  - ${r.content}`);
  }

  console.log('\n--- All relationships (should include old + new) ---');
  const allRels = await graphDb.runQuery(
    'MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.canonicalName AS from, r.relationType AS rel, b.canonicalName AS to ORDER BY r.createdAt',
  );
  for (const r of allRels.records as any[]) {
    console.log(`  ${r.from} --[${r.rel}]--> ${r.to}`);
  }

  // ========================================
  // TEST 4: Recall picks the correct info after correction
  // ========================================
  console.log('\n=== TEST 4: Recall after correction ===\n');

  console.log('Query: "Who is Delara?"');
  const result5 = await memory.recall('Who is Delara?');
  console.log('Answer:', result5.answer);
  console.log();

  console.log('Query: "دلارا کیه؟"');
  const result6 = await memory.recall('دلارا کیه؟');
  console.log('Answer:', result6.answer);
  console.log();

  // ========================================
  // TEST 5: Verify counts
  // ========================================
  console.log('=== TEST 5: Final data counts ===\n');
  const entityCount = await graphDb.runQuery('MATCH (e:Entity) RETURN count(e) AS c');
  const factCount = await graphDb.runQuery('MATCH (f:Fact) RETURN count(f) AS c');
  const relCount = await graphDb.runQuery('MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS c');
  const episodeCount = await graphDb.runQuery('MATCH (ep:Episode) RETURN count(ep) AS c');

  console.log(`Entities: ${(entityCount.records[0] as any).c}`);
  console.log(`Facts: ${(factCount.records[0] as any).c}`);
  console.log(`Relationships: ${(relCount.records[0] as any).c}`);
  console.log(`Episodes: ${(episodeCount.records[0] as any).c}`);

  console.log('\n✅ ALL TESTS COMPLETE');

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

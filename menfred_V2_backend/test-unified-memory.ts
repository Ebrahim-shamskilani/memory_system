/**
 * Integration test for the Unified Memory System.
 * Run: npx ts-node test-unified-memory.ts
 *
 * Tests:
 * 1. Phase 1: Insert entities + relationships, verify dual-write
 * 2. Phase 2: Query "Who is mother of Delara?" end-to-end
 * 3. Multilingual: search for آرزو and "Arezoo"
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { UnifiedMemoryService } from './src/unified-memory/unified-memory.service';
import { GraphDbService } from './src/graph-db/graph-db.service';
import { ChromadbService } from './src/chromadb/chromadb.service';

async function main() {
  console.log('=== Booting NestJS app for testing ===\n');
  const app = await NestFactory.createApplicationContext(AppModule);

  const memory = app.get(UnifiedMemoryService);
  const graphDb = app.get(GraphDbService);
  const chromaDb = app.get(ChromadbService);

  // Clean up previous test data
  console.log('--- Cleaning up previous test data ---');
  try {
    await graphDb.runQuery('MATCH (n) DETACH DELETE n');
    console.log('  Neo4j cleared.');
  } catch (e) {
    console.log('  Neo4j clear skipped:', (e as Error).message);
  }
  // ChromaDB collections will be overwritten by upsert

  // ========================================
  // PHASE 1: Insert test entities
  // ========================================
  console.log('\n=== PHASE 1: Insert entities + relationships ===\n');

  const ebrahim = await memory.createEntity({
    canonicalName: 'ابراهیم',
    aliases: ['Ebrahim', 'Ibrahim'],
    entityType: 'person',
    description: 'The user of the system, a software developer who wants to learn German',
  });
  console.log('Created ابراهیم:', ebrahim);

  const arezoo = await memory.createEntity({
    canonicalName: 'آرزو',
    aliases: ['Arezoo', 'Arezo'],
    entityType: 'person',
    description: 'Wife of Ebrahim, mother of Delara',
  });
  console.log('Created آرزو:', arezoo);

  const delara = await memory.createEntity({
    canonicalName: 'دلارا',
    aliases: ['Delara'],
    entityType: 'person',
    description: 'Daughter of Ebrahim and Arezoo, a young child',
  });
  console.log('Created دلارا:', delara);

  // Insert relationships
  const marriedTo = await memory.createRelationship({
    sourceChromaId: ebrahim.chromaId,
    targetChromaId: arezoo.chromaId,
    relationType: 'married_to',
    description: 'ابراهیم is married to آرزو',
    confidence: 1.0,
  });
  console.log('Created married_to:', marriedTo);

  const fatherOf = await memory.createRelationship({
    sourceChromaId: ebrahim.chromaId,
    targetChromaId: delara.chromaId,
    relationType: 'father_of',
    description: 'ابراهیم is father of دلارا',
    confidence: 1.0,
  });
  console.log('Created father_of:', fatherOf);

  const motherOf = await memory.createRelationship({
    sourceChromaId: arezoo.chromaId,
    targetChromaId: delara.chromaId,
    relationType: 'mother_of',
    description: 'آرزو is mother of دلارا',
    confidence: 1.0,
  });
  console.log('Created mother_of:', motherOf);

  // Add a fact
  const fact = await memory.createFact({
    content: 'Ebrahim wants to learn German',
    source: 'stated',
    confidence: 1.0,
  });
  console.log('Created fact:', fact);

  await memory.linkEntityToFact(
    ebrahim.chromaId,
    fact.chromaId,
    'Ebrahim stated he wants to learn German',
  );
  console.log('Linked fact to ابراهیم');

  // Verify Neo4j
  console.log('\n--- Verify Neo4j ---');
  const neo4jEntities = await graphDb.runQuery(
    'MATCH (e:Entity) RETURN e.canonicalName AS name, e.chromaId AS chromaId, e.entityType AS type',
  );
  console.log('Neo4j entities:', JSON.stringify(neo4jEntities.records, null, 2));

  const neo4jRels = await graphDb.runQuery(
    'MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.canonicalName AS from, r.relationType AS rel, b.canonicalName AS to, r.chromaId AS chromaId',
  );
  console.log('Neo4j relationships:', JSON.stringify(neo4jRels.records, null, 2));

  // Verify ChromaDB
  console.log('\n--- Verify ChromaDB ---');
  const entityResults = await chromaDb.queryCollection('entities', 'Delara', 5);
  console.log('ChromaDB search "Delara" in entities:');
  console.log('  IDs:', entityResults.ids?.[0]);
  console.log('  Documents:', entityResults.documents?.[0]);
  console.log('  Distances:', entityResults.distances?.[0]);

  const relResults = await chromaDb.queryCollection('relationships', 'mother', 5);
  console.log('\nChromaDB search "mother" in relationships:');
  console.log('  IDs:', relResults.ids?.[0]);
  console.log('  Documents:', relResults.documents?.[0]);
  console.log('  Distances:', relResults.distances?.[0]);

  // Verify ID bridging
  console.log('\n--- Verify ID bridging ---');
  const chromaEntity = await chromaDb.getByIds('entities', [ebrahim.chromaId]);
  console.log(
    `ChromaDB lookup by ابراهیم chromaId (${ebrahim.chromaId}):`,
    chromaEntity.documents?.[0],
  );

  console.log('\n✅ PHASE 1 COMPLETE\n');

  // ========================================
  // PHASE 2: End-to-end retrieval
  // ========================================
  console.log('=== PHASE 2: End-to-end retrieval ===\n');

  console.log('Query: "Who is mother of Delara?"');
  const result1 = await memory.recall('Who is mother of Delara?');
  console.log('Answer:', result1.answer);
  console.log('Iterations:', result1.iterations);
  console.log('Sources:', JSON.stringify(result1.sources, null, 2));

  console.log('\nQuery: "What does Ebrahim want to learn?"');
  const result2 = await memory.recall('What does Ebrahim want to learn?');
  console.log('Answer:', result2.answer);
  console.log('Iterations:', result2.iterations);

  console.log('\nQuery: "Tell me about ابراهیم family"');
  const result3 = await memory.recall('Tell me about ابراهیم family');
  console.log('Answer:', result3.answer);
  console.log('Iterations:', result3.iterations);

  // ========================================
  // MULTILINGUAL TEST
  // ========================================
  console.log('\n=== MULTILINGUAL TEST ===\n');

  const searchFarsi = await chromaDb.queryCollection('entities', 'آرزو', 3);
  console.log('Search "آرزو" in entities:');
  console.log('  Documents:', searchFarsi.documents?.[0]);
  console.log('  Distances:', searchFarsi.distances?.[0]);

  const searchEn = await chromaDb.queryCollection('entities', 'Arezoo', 3);
  console.log('\nSearch "Arezoo" in entities:');
  console.log('  Documents:', searchEn.documents?.[0]);
  console.log('  Distances:', searchEn.distances?.[0]);

  console.log('\nQuery: "Kennst du Arezoo?"');
  const result4 = await memory.recall('Kennst du Arezoo?');
  console.log('Answer:', result4.answer);

  console.log('\n✅ ALL TESTS COMPLETE');

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

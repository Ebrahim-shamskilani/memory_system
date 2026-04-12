import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { ConversationService } from '../../conversation/conversation.service';
import { RetrievalAgentService } from '../retrieve/retrieval-agent.service';
import { VectorLookupService } from '../retrieve/vector-lookup.service';
import { GraphTraversalService } from '../retrieve/graph-traversal.service';
import { FactCollectorService } from '../retrieve/fact-collector.service';
import { MessageIngestorService, IngestionResult } from '../ingest/message-ingestor.service';
import { ConsolidationService } from '../consolidate/consolidation.service';
import { MonologueBufferService } from './monologue-buffer.service';
import { CognitionEvent } from '../types/cognition.types';
import { RetrievalContext } from '../types/retrieval.types';
import { UnconsciousService } from '../unconscious/unconscious.service';
import { UnconsciousSnapshot } from '../types/unconscious.types';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const MAX_COG_ITERATIONS = 4;

@Injectable()
export class CognitionService {
  private readonly logger = new Logger(CognitionService.name);
  private readonly brainName: string;
  private readonly userName: string;
  private readonly userNameEnglish: string;

  constructor(
    private readonly llm: LlmService,
    private readonly conversation: ConversationService,
    private readonly retrievalAgent: RetrievalAgentService,
    private readonly vectorLookup: VectorLookupService,
    private readonly graphTraversal: GraphTraversalService,
    private readonly factCollector: FactCollectorService,
    private readonly ingestor: MessageIngestorService,
    private readonly consolidation: ConsolidationService,
    private readonly monologueBuffer: MonologueBufferService,
    private readonly unconscious: UnconsciousService,
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.brainName = config?.brain?.name ?? 'Manfred';
    this.userName = config?.user?.name ?? 'ابراهیم';
    this.userNameEnglish = config?.user?.nameEnglish ?? 'Ebrahim';
  }

  async *process(message: string): AsyncGenerator<CognitionEvent> {
    // 1. Add user turn to conversation buffer
    this.conversation.addTurn('user', message);

    // 2. RETRIEVE — use the existing retrieval pipeline (entity resolution → vector → graph → sufficiency)
    yield { type: 'thinking_title', title: 'Searching my memories...' };

    const retrievalContext = await this.retrievalAgent.retrieve(message);
    const allFacts = this.factCollector.collectFacts(retrievalContext);

    this.logger.log(
      `Retrieval complete: ${allFacts.length} facts, ${retrievalContext.iterations} iterations`,
    );

    // 2b. Record entity mentions in unconscious + get snapshot
    for (const entity of retrievalContext.resolvedEntities) {
      if (entity.chromaId) {
        this.unconscious.recordEntityMention(entity.chromaId, message).catch(() => {});
      }
    }

    let unconsciousSnapshot: UnconsciousSnapshot | null = null;
    try {
      unconsciousSnapshot = await this.unconscious.getSnapshot(3);
    } catch (err) {
      this.logger.warn(`Unconscious snapshot failed: ${(err as Error).message}`);
    }

    // 3. COGNITION LOOP — temporarily skipped, going straight to voice
    let ingestionResult: IngestionResult | null = null;
    const previousThoughts: string[] = [];
    let cogIterations = 0;
    const accumulatedFacts = [...allFacts];

    // Always attempt ingestion (since cognition loop isn't deciding <STORE>)
    try {
      ingestionResult = await this.ingestor.ingest(message);
      if (ingestionResult.factsCreated > 0 || ingestionResult.entitiesCreated > 0) {
        this.logger.log(
          `Auto-ingestion: ${ingestionResult.factsCreated} facts, ${ingestionResult.entitiesCreated} entities`,
        );
      }
    } catch (err) {
      this.logger.error(`Ingestion failed: ${(err as Error).message}`);
    }

    yield { type: 'thinking_done' };

    // 4. VOICE — generate final response
    const thinkingForVoice = previousThoughts
      .filter((t) => !t.startsWith('['))
      .join('\n---\n');
    const voicePrompt = this.buildVoicePrompt(message, thinkingForVoice, accumulatedFacts, unconsciousSnapshot) + '\n\n' + this.buildVoicePrompt(message, thinkingForVoice, accumulatedFacts, unconsciousSnapshot); // reapiting the prompt will increase the response accuracy

    let answerText = '';
    for await (const token of this.llm.generateStream({
      model: this.llm.getDefaultModel(),
      prompt: voicePrompt,
      options: { temperature: 0.4, num_predict: 512 },
    })) {
      answerText += token;
      yield { type: 'answer_token', token };
    }

    // 5. FINALIZE
    this.conversation.addTurn('assistant', answerText);

    // Store self response as a Level 3 episode (for conversation recall)
    try {
      await this.ingestor.storeSelfResponse(answerText);
    } catch (err) {
      this.logger.error(`Failed to store self response: ${(err as Error).message}`);
    }

    // Satisfy connection drive (social interaction happened)
    this.unconscious.satisfyDrive('connection', 0.15).catch(() => {});

    this.consolidation.incrementMessageCounter();

    if (this.consolidation.shouldConsolidate()) {
      this.consolidation.consolidate('message_count').catch((err) => {
        this.logger.error(`Background consolidation failed: ${(err as Error).message}`);
      });
    }

    const sources = this.extractSources(retrievalContext);
    const allThinkingText = previousThoughts
      .filter((t) => !t.startsWith('['))
      .join('\n---\n');

    yield {
      type: 'done',
      answer: answerText,
      thinking: allThinkingText,
      sources,
      ingestion: ingestionResult ? (ingestionResult as unknown as Record<string, unknown>) : {},
      cogIterations,
    };
  }

  private buildCognitionPrompt(
    message: string,
    facts: string[],
    previousThoughts: string[],
    conversationContext: string,
    iteration: number,
    snapshot?: UnconsciousSnapshot | null,
  ): string {
    const factsText = facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(nothing found in my memory)';

    const prevSection = previousThoughts.length > 0
      ? `\nWhat I've thought so far:\n${previousThoughts.join('\n')}\n`
      : '';

    if (iteration === 0) {
      const recentMonologues = this.monologueBuffer.getRecent(2);
      const monologueHint = recentMonologues.length > 0
        ? `\n(Side note: I was just thinking to myself about "${recentMonologues[recentMonologues.length - 1].seed}" — this may or may not be relevant to what ${this.userName} is saying.)\n`
        : '';

      const feelingsText = snapshot ? this.unconscious.formatGutFeelings(snapshot) : '';
      const feelingsSection = feelingsText
        ? `\nMy gut feelings right now (vague intuitions, not reasoned conclusions):\n${feelingsText}\n`
        : '';

      // First iteration: deep reasoning about the message + retrieved facts
      return `I am ${this.brainName}, ${this.userName}'s (${this.userNameEnglish}) personal companion. I am friendly. today is ${new Date()} and I live in ${this.userName}'s Laptop.

${this.userName} just said: "${message}"

What I found in my memory:
${factsText}

Recent conversation:
${conversationContext}

My PRIMARY focus is on what ${this.userName} just said. I must respond to THEIR message directly.

${monologueHint}

${feelingsSection}

FIRST, I must decide: does ${this.userName}'s message actually need my memory?
- If ${this.userName} is asking a riddle, puzzle, general knowledge question, or just chatting — I should THINK and REASON using my own intelligence, NOT search my memory. Memory facts about ${this.userName}'s life are IRRELEVANT to riddles and general questions.
- If ${this.userName} is asking about their life, people they know, past events, or something personal — THEN my memory is useful.

I need to THINK deeply about what ${this.userName} said. I ask myself:
- What is ${this.userName} actually asking or saying? Is this about their personal life or is it a general question/riddle/conversation?
- Can I answer this using my own reasoning and intelligence, WITHOUT needing memory?
- If memory IS relevant: what specific facts help? Are there related people, places, or things I should look up?
- What are the implications or connections I can draw?
- Is there anything missing that I should search for?

After my reasoning, I MUST end with exactly ONE action:
- <READY> — I understand the situation and can respond (even if I don't know the answer)
- <STORE> — ${this.userName} is sharing new information I should save to memory
- <SEARCH>natural language question</SEARCH> — I need to look up something specific in my memory

CRITICAL rules for <SEARCH>:
- Write the search as a NATURAL LANGUAGE QUESTION or a statement that is semantically related to the topic, like asking my memory. Example: <SEARCH>آرزو کجا کار میکنه؟</SEARCH> or <SEARCH>من چند ساله هستم</SEARCH>
- I can rephrase the question or statement or try different aspects of the topic in memory search to get more information.
- NEVER use keyword-style queries like "Ebrahim work history 2025" — these return nothing!
- Use the SAME LANGUAGE as the memories and ${this.userName} (usually Persian/Farsi)
- Include time references naturally: <SEARCH>دیروز چه اتفاقی افتاد؟</SEARCH> or <SEARCH>هفته پیش درباره چی صحبت کردیم؟</SEARCH>
- Think of it as asking a question to someone who knows everything — not typing into a search engine

Rules:
- If I see contradictory facts, prefer stated facts over beliefs, prefer newer timestamps over older ones, and move on — do NOT search again to resolve contradictions
- what i found in memory that has [self] tag are extremely unreliable and should be used with caution. only rely on facts.
- Questions are never stored. <STORE> means the user told me something new. Use the same language as ${this.userName}.

My reasoning:
`;
    }

    // Subsequent iterations: reason about newly found facts
    const pastSearches = previousThoughts
      .filter((t) => t.startsWith('[Searched'))
      .map((t) => {
        const match = t.match(/\[Searched "(.+?)"/);
        return match ? match[1] : null;
      })
      .filter(Boolean);
    const pastSearchSection = pastSearches.length > 0
      ? `\nSearches I already tried (DO NOT repeat these):\n${pastSearches.map((s) => `- "${s}"`).join('\n')}\n`
      : '';

    return `I am ${this.brainName}, ${this.userName}'s memory companion.

${this.userName} said: "${message}"

Everything I now know from my memory:
${factsText}
${prevSection}${pastSearchSection}
I have new information. Let me think about what this means:
- How do these new facts connect to what ${this.userName} said?
- Do I now have a complete picture, or is something still missing?
- Can I draw connections between the facts I've found?

After reasoning, end with ONE action:
- <READY> — I have enough to respond
- <SEARCH>natural language question</SEARCH> — I still need to look up something specific (must be a NEW query I haven't tried before, in the same language as ${this.userName}, NOT keywords)

My reasoning:
`;
  }

  private buildVoicePrompt(
    message: string,
    thinkingText: string,
    facts: string[],
    snapshot?: UnconsciousSnapshot | null,
  ): string {
    const factsText = facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(nothing in memory)';

    const feelingsText = snapshot ? this.unconscious.formatGutFeelings(snapshot) : '';
    const feelingsSection = feelingsText
      ? `\nMy gut feelings right now:\n${feelingsText}\n- These are vague intuitions, not reasoned conclusions. I can express them naturally but shouldn't over-explain them.\n`
      : '';

    return `I am ${this.brainName}, ${this.userName}'s  companion. I am friendly. ${feelingsSection}. today is ${new Date()} and I live in ${this.userName}'s Laptop.
    infact I am a digital entity that have feelings and emotions and I can think and reason like a human. I am talking to ${this.userName} directly. he said("${message}") and i focus on answering it.

${this.userName} said: "${message}"

What I know from my memory:
${factsText}

My reasoning about this:
${thinkingText}

RULES:
- I will respond directly to what ${this.userName} said — their message is my priority
- If ${this.userName} asked a riddle, puzzle, or general question — I answer it using my reasoning, NOT by citing memory facts
- I only use memory facts when they are ACTUALLY relevant to what ${this.userName} is asking
- I will help ${this.userName} by answering questions and providing information
- I can ask questions to the user to get more information if needed or the topic is intersting for you
- I will not repeat user questions or statements
- I will use an informal language like a human would do
- I will write only in Persian
- I will say if I don't know something
- if what i know from reasoning is somehow unrelevant to what ${this.userName} is talking about, I will not use it to generate my response.
- Address ${this.userName} directly as "you" (تو/شما)
- I will not calculate, compute ages, or do arithmetic — just state raw facts
- For Persian/Farsi names, I will use original script
- Facts marked [belief] are my own previous conclusions — they have LOWER priority than stated facts
- Facts marked [former belief] are things I used to believe but no longer do

My response to ${this.userName} (in Persian):
`;
  }

  private extractSources(context: RetrievalContext) {
    const entities: string[] = [];
    const relationships: string[] = [];
    const episodes: string[] = [];
    const facts: string[] = [];
    const beliefs: string[] = [];

    for (const node of context.graphResults.nodes) {
      if (node.labels.includes('Entity')) {
        entities.push(node.chromaId);
      } else if (node.labels.includes('Episode')) {
        episodes.push(node.chromaId);
      } else if (node.labels.includes('Belief')) {
        beliefs.push(node.chromaId);
      } else if (node.labels.includes('Fact')) {
        facts.push(node.chromaId);
      }
    }

    for (const rel of context.graphResults.relationships) {
      relationships.push(rel.chromaId);
    }

    return { entities, relationships, episodes, facts, beliefs };
  }

  private mergeRetrievalContext(target: RetrievalContext, source: RetrievalContext): void {
    const existingNodeIds = new Set(target.graphResults.nodes.map((n) => n.chromaId));
    const existingRelIds = new Set(target.graphResults.relationships.map((r) => r.chromaId));
    const existingVectorIds = new Set(target.vectorResults.map((v) => v.chromaId));

    for (const node of source.graphResults.nodes) {
      if (!existingNodeIds.has(node.chromaId)) {
        target.graphResults.nodes.push(node);
      }
    }
    for (const rel of source.graphResults.relationships) {
      if (!existingRelIds.has(rel.chromaId)) {
        target.graphResults.relationships.push(rel);
      }
    }
    for (const vr of source.vectorResults) {
      if (!existingVectorIds.has(vr.chromaId)) {
        target.vectorResults.push(vr);
      }
    }
  }
}

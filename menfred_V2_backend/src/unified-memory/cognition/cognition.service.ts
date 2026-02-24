import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { LlmService } from '../../llm/llm.service';
import { ConversationService } from '../../conversation/conversation.service';
import { RetrievalAgentService } from '../retrieve/retrieval-agent.service';
import { VectorLookupService } from '../retrieve/vector-lookup.service';
import { GraphTraversalService } from '../retrieve/graph-traversal.service';
import { MessageIngestorService, IngestionResult } from '../ingest/message-ingestor.service';
import { ConsolidationService } from '../consolidate/consolidation.service';
import { CognitionEvent } from '../types/cognition.types';
import { RetrievalContext } from '../types/retrieval.types';
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
    private readonly ingestor: MessageIngestorService,
    private readonly consolidation: ConsolidationService,
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
    const allFacts = this.collectFacts(retrievalContext);

    this.logger.log(
      `Retrieval complete: ${allFacts.length} facts, ${retrievalContext.iterations} iterations`,
    );

    // 3. COGNITION LOOP — genuine thinking with follow-up searches
    let alreadyIngested = false;
    let ingestionResult: IngestionResult | null = null;
    const previousThoughts: string[] = [];
    let cogIterations = 0;
    const accumulatedFacts = [...allFacts];
    const seenFacts = new Set(allFacts);

    for (let i = 0; i < MAX_COG_ITERATIONS; i++) {
      cogIterations++;
      yield {
        type: 'thinking_title',
        title: i === 0 ? 'Thinking...' : 'Thinking deeper...',
      };

      const conversationContext = this.conversation.getContextString();
      const cogPrompt = this.buildCognitionPrompt(
        message,
        accumulatedFacts,
        previousThoughts,
        conversationContext,
        i,
      ) + '\n\n' + this.buildCognitionPrompt(
        message,
        accumulatedFacts,
        previousThoughts,
        conversationContext,
        i,
      ); // reapiting the prompt will increase the response accuracy

      let thought = '';
      for await (const token of this.llm.generateStream({
        model: this.llm.getDefaultModel(),
        prompt: cogPrompt,
        options: { temperature: 0.4, num_predict: 400 },
      })) {
        thought += token;
        yield { type: 'thinking_token', token };
      }

      // Extract the clean reasoning (strip action tags)
      let cleanThought = thought
        .replace(/<READY>/g, '')
        .replace(/<STORE\s*\/?>([\s\S]*?<\/STORE>)?/g, '')
        .replace(/<SEARCH>[\s\S]*?<\/SEARCH>/g, '')
        .trim();

      previousThoughts.push(cleanThought);

      // Parse action tags
      const hasReady = thought.includes('<READY>');
      const hasStore = /<STORE/.test(thought);
      const searchMatches = [...thought.matchAll(/<SEARCH>([\s\S]*?)<\/SEARCH>/g)];

      // Handle <STORE>
      if (hasStore && !alreadyIngested) {
        yield { type: 'thinking_title', title: 'Storing new information...' };
        try {
          ingestionResult = await this.ingestor.ingest(message);
          alreadyIngested = true;
          this.logger.log(
            `Cognition triggered ingestion: ${ingestionResult.factsCreated} facts, ${ingestionResult.entitiesCreated} entities`,
          );
        } catch (err) {
          this.logger.error(`Ingestion failed: ${(err as Error).message}`);
        }
      }

      // Handle <SEARCH> — do follow-up retrieval for each search query
      if (searchMatches.length > 0) {
        for (const match of searchMatches) {
          const searchQuery = match[1].trim();
          if (!searchQuery) continue;

          yield { type: 'thinking_title', title: `Searching: ${searchQuery}...` };

          try {
            // Use the full retrieval pipeline for the follow-up search
            const followUpContext = await this.retrievalAgent.retrieve(searchQuery);
            const newFacts = this.collectFacts(followUpContext);
            let added = 0;
            for (const fact of newFacts) {
              if (!seenFacts.has(fact)) {
                seenFacts.add(fact);
                accumulatedFacts.push(fact);
                added++;
              }
            }
            previousThoughts.push(`[Searched "${searchQuery}" → ${added} new facts found]`);
            this.logger.log(`Follow-up search "${searchQuery}": ${added} new facts`);

            // Merge sources
            this.mergeRetrievalContext(retrievalContext, followUpContext);
          } catch (err) {
            this.logger.warn(`Follow-up search failed: ${(err as Error).message}`);
            previousThoughts.push(`[Searched "${searchQuery}" → search failed]`);
          }
        }

        // If we searched, don't break — let the next iteration reason about new facts
        if (hasReady) break;
        continue;
      }

      // Break conditions (when no <SEARCH> was found)
      if (hasReady || hasStore) break;
      // No action tag at all — done thinking
      break;
    }

    yield { type: 'thinking_done' };

    // 4. VOICE — generate final response
    const thinkingForVoice = previousThoughts
      .filter((t) => !t.startsWith('['))
      .join('\n---\n');
    const voicePrompt = this.buildVoicePrompt(message, thinkingForVoice, accumulatedFacts) + '\n\n' + this.buildVoicePrompt(message, thinkingForVoice, accumulatedFacts); // reapiting the prompt will increase the response accuracy

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
  ): string {
    const factsText = facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(nothing found in my memory)';

    const prevSection = previousThoughts.length > 0
      ? `\nWhat I've thought so far:\n${previousThoughts.join('\n')}\n`
      : '';

    if (iteration === 0) {
      // First iteration: deep reasoning about the message + retrieved facts
      return `I am ${this.brainName}, ${this.userName}'s (${this.userNameEnglish}) personal companion. I am friendly. today is ${new Date()} and I live in ${this.userName}'s Laptop.

${this.userName} just said: "${message}"

What I found in my memory:
${factsText}

Recent conversation:
${conversationContext}

I need to THINK deeply about this. I ask myself:
- Who exactly is ${this.userName} referring to? What do I know about them?
- What specific facts from my memory are relevant here?
- Is ${this.userName} asking a question, telling me something new, or making a request?
- Are there related people, places, or things I should look up?
- I must ask myself defrent aspects of what ${this.userName} is asking me.
- Should I look up my memory for a specific time period? I can search with time references like "last week" or "yesterday"
- Should I look up my memory to understand context based on recent episodes?
- What are the implications or connections I can draw from what I know?
- Is there anything ${this.userName} might expect me to know that I haven't found yet?

After my reasoning, I MUST end with exactly ONE action:
- <READY> — I understand the situation and can respond (even if I don't know the answer)
- <STORE> — ${this.userName} is sharing new information I should save to memory
- <SEARCH>specific query</SEARCH> — I need to look up something specific in my memory

Rules: Questions are never stored. <STORE> means the user told me something new. Use the same language as ${this.userName}.

My reasoning:
`;
    }

    // Subsequent iterations: reason about newly found facts
    return `I am ${this.brainName}, ${this.userName}'s memory companion.

${this.userName} said: "${message}"

Everything I now know from my memory:
${factsText}
${prevSection}
I have new information. Let me think about what this means:
- How do these new facts connect to what ${this.userName} said?
- Do I now have a complete picture, or is something still missing?
- Can I draw connections between the facts I've found?

After reasoning, end with ONE action:
- <READY> — I have enough to respond
- <SEARCH>specific query</SEARCH> — I still need to look up something specific

My reasoning:
`;
  }

  private buildVoicePrompt(
    message: string,
    thinkingText: string,
    facts: string[],
  ): string {
    const factsText = facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(nothing in memory)';

    return `I am ${this.brainName}, ${this.userName}'s  companion. I am friendly. today is ${new Date()} and I live in ${this.userName}'s Laptop.
    infact I am a digital entity that have feelings and emotions and I can think and reason like a human.
${this.userName} said: "${message}"

My reasoning about this:
${thinkingText}

All facts from my memory:
${factsText}

RULES:
- I will help ${this.userName} by answering questions and providing information
- I can ask questions to the user to get more information if needed or the topic is intersting for you
- I will not repeat user questions or statements
- I will use an informal language like a human would do
- I will write only in Persian
- I will say if I don't know something
- Address ${this.userName} directly as "you" (تو/شما)
- I will not calculate, compute ages, or do arithmetic — just state raw facts
- For Persian/Farsi names, I will use original script

My response to ${this.userName} (in Persian):
`;
  }

  private collectFacts(context: RetrievalContext): string[] {
    const facts = new Set<string>();

    for (const fact of context.facts) {
      facts.add(fact);
    }

    for (const node of context.graphResults.nodes) {
      const desc = node.properties.description ?? node.properties.content ?? node.properties.canonicalName;
      if (desc) facts.add(String(desc));
    }

    for (const rel of context.graphResults.relationships) {
      const desc = rel.properties.description;
      if (desc) facts.add(String(desc));
    }

    for (const vr of context.vectorResults) {
      if (vr.document && vr.distance < 0.5) {
        // Include timestamp so the LLM can identify temporal context
        // (e.g., which facts are from "yesterday" vs "today")
        const ts = vr.metadata?.timestamp ?? vr.metadata?.created_at;
        const prefix = ts ? `[${ts}] ` : '';
        facts.add(`${prefix}${vr.document}`);
      }
    }

    return Array.from(facts);
  }

  private extractSources(context: RetrievalContext) {
    const entities: string[] = [];
    const relationships: string[] = [];
    const episodes: string[] = [];
    const facts: string[] = [];

    for (const node of context.graphResults.nodes) {
      if (node.labels.includes('Entity')) {
        entities.push(node.chromaId);
      } else if (node.labels.includes('Episode')) {
        episodes.push(node.chromaId);
      } else if (node.labels.includes('Fact')) {
        facts.push(node.chromaId);
      }
    }

    for (const rel of context.graphResults.relationships) {
      relationships.push(rel.chromaId);
    }

    return { entities, relationships, episodes, facts };
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

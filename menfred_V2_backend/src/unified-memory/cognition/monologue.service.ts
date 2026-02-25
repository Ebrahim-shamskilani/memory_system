import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { LlmService } from '../../llm/llm.service';
import { ConversationService } from '../../conversation/conversation.service';
import { RetrievalAgentService } from '../retrieve/retrieval-agent.service';
import { VectorLookupService } from '../retrieve/vector-lookup.service';
import { GraphTraversalService } from '../retrieve/graph-traversal.service';
import { MonologueBufferService } from './monologue-buffer.service';
import { MonologueEntry, MonologueEvent } from '../types/monologue.types';
import { RetrievalContext } from '../types/retrieval.types';
import { MENFRED_MEMORY_CONFIG, MenfredMemoryConfig } from '../../sdk/menfred-memory.config';

const MAX_COG_ITERATIONS = 4;

class AbortedError extends Error {
  constructor() {
    super('Monologue aborted');
    this.name = 'AbortedError';
  }
}

@Injectable()
export class MonologueService {
  private readonly logger = new Logger(MonologueService.name);
  private readonly brainName: string;
  private readonly userName: string;
  private readonly userNameEnglish: string;

  private paused = true;
  private running = false;
  private abortController: AbortController | null = null;
  private connectedClients = 0;
  private postReactive = false;

  readonly events = new EventEmitter();

  constructor(
    private readonly llm: LlmService,
    private readonly conversation: ConversationService,
    private readonly retrievalAgent: RetrievalAgentService,
    private readonly vectorLookup: VectorLookupService,
    private readonly graphTraversal: GraphTraversalService,
    private readonly monologueBuffer: MonologueBufferService,
    @Inject(MENFRED_MEMORY_CONFIG) @Optional() config?: MenfredMemoryConfig,
  ) {
    this.brainName = config?.brain?.name ?? 'Manfred';
    this.userName = config?.user?.name ?? 'ابراهیم';
    this.userNameEnglish = config?.user?.nameEnglish ?? 'Ebrahim';
  }

  /**
   * Pause for reactive processing — dumps old train of thought,
   * next resume will pick a fresh seed.
   */
  pause(): void {
    this.paused = true;
    this.postReactive = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.logger.log('Monologue paused (reactive)');
  }

  /**
   * Pause due to SSE disconnect — no context shift, just stop.
   */
  pauseDisconnect(): void {
    this.paused = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.logger.log('Monologue paused (no clients)');
  }

  resume(): void {
    this.paused = false;
    this.logger.log(`Monologue resumed (postReactive: ${this.postReactive})`);
    if (!this.running) {
      this.startLoop();
    }
  }

  clientConnected(): void {
    this.connectedClients++;
    this.logger.log(`SSE client connected (total: ${this.connectedClients})`);
    if (this.connectedClients === 1) {
      this.resume();
    }
  }

  clientDisconnected(): void {
    this.connectedClients = Math.max(0, this.connectedClients - 1);
    this.logger.log(`SSE client disconnected (total: ${this.connectedClients})`);
    if (this.connectedClients === 0) {
      this.pauseDisconnect();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  getBuffer(): MonologueBufferService {
    return this.monologueBuffer;
  }

  // --- Loop ---

  private async startLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.log('Monologue loop started');

    while (!this.paused) {
      this.abortController = new AbortController();
      try {
        await this.runOneCycle(this.abortController.signal);
      } catch (err) {
        if (err instanceof AbortedError) {
          this.logger.log('Monologue cycle aborted (paused for reactive)');
        } else {
          this.logger.error(`Monologue cycle error: ${(err as Error).message}`);
          this.emit({ type: 'monologue_error', message: (err as Error).message });
          // Sleep to avoid tight error loop
          await this.sleep(2000);
        }
      }
    }

    this.running = false;
    this.logger.log('Monologue loop stopped');
  }

  private async runOneCycle(signal: AbortSignal): Promise<void> {
    const startTime = Date.now();
    const monologueId = randomUUID();

    // Step 1: Pick seed
    const seed = await this.pickSeed(signal);
    this.checkAborted(signal);
    this.logger.log(`Monologue seed: "${seed}"`);

    // Step 2: Retrieve (full pipeline)
    this.emit({ type: 'monologue_thinking_title', title: `Reflecting on: ${seed.substring(0, 50)}...`, monologueId });
    const retrievalContext = await this.retrievalAgent.retrieve(seed);
    this.checkAborted(signal);
    const allFacts = this.collectFacts(retrievalContext);

    // Step 3: Cognition loop
    const previousThoughts: string[] = [];
    const accumulatedFacts = [...allFacts];
    const seenFacts = new Set(allFacts);

    for (let i = 0; i < MAX_COG_ITERATIONS; i++) {
      this.checkAborted(signal);
      this.emit({
        type: 'monologue_thinking_title',
        title: i === 0 ? 'Reflecting...' : 'Thinking deeper...',
        monologueId,
      });

      const monologueContext = this.monologueBuffer.getContextString();
      const cogPrompt = this.buildCognitionPrompt(seed, accumulatedFacts, previousThoughts, monologueContext, i)
        + '\n\n'
        + this.buildCognitionPrompt(seed, accumulatedFacts, previousThoughts, monologueContext, i);

      let thought = '';
      for await (const token of this.llm.generateStream({
        model: this.llm.getDefaultModel(),
        prompt: cogPrompt,
        options: { temperature: 0.4, num_predict: 400 },
      })) {
        this.checkAborted(signal);
        thought += token;
        this.emit({ type: 'monologue_thinking_token', token, monologueId });
      }

      const cleanThought = thought
        .replace(/<READY>/g, '')
        .replace(/<STORE\s*\/?>([\s\S]*?<\/STORE>)?/g, '')
        .replace(/<SEARCH>[\s\S]*?<\/SEARCH>/g, '')
        .trim();
      previousThoughts.push(cleanThought);

      const hasReady = thought.includes('<READY>');
      const searchMatches = [...thought.matchAll(/<SEARCH>([\s\S]*?)<\/SEARCH>/g)];

      // Handle <SEARCH> — follow-up retrieval
      if (searchMatches.length > 0) {
        for (const match of searchMatches) {
          const searchQuery = match[1].trim();
          if (!searchQuery) continue;

          this.checkAborted(signal);
          this.emit({ type: 'monologue_thinking_title', title: `Searching: ${searchQuery}...`, monologueId });

          try {
            const followUpContext = await this.retrievalAgent.retrieve(searchQuery);
            this.checkAborted(signal);
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
          } catch (err) {
            if (err instanceof AbortedError) throw err;
            previousThoughts.push(`[Searched "${searchQuery}" → search failed]`);
          }
        }

        if (hasReady) break;
        continue;
      }

      if (hasReady) break;
      break;
    }

    this.checkAborted(signal);
    this.emit({ type: 'monologue_thinking_done', monologueId });

    // Step 4: Voice — generate voiced monologue
    const thinkingForVoice = previousThoughts
      .filter((t) => !t.startsWith('['))
      .join('\n---\n');

    const voicePrompt = this.buildVoicePrompt(seed, thinkingForVoice, accumulatedFacts)
      + '\n\n'
      + this.buildVoicePrompt(seed, thinkingForVoice, accumulatedFacts);

    let voicedOutput = '';
    for await (const token of this.llm.generateStream({
      model: this.llm.getDefaultModel(),
      prompt: voicePrompt,
      options: { temperature: 0.4, num_predict: 512 },
    })) {
      this.checkAborted(signal);
      voicedOutput += token;
      this.emit({ type: 'monologue_voice_token', token, monologueId });
    }

    this.checkAborted(signal);

    // Step 5: Extract next seed
    const nextSeed = await this.extractNextSeed(seed, voicedOutput, signal);

    // Step 6: Buffer & emit
    const allThinkingText = previousThoughts
      .filter((t) => !t.startsWith('['))
      .join('\n---\n');

    const entry: MonologueEntry = {
      id: monologueId,
      seed,
      thinking: allThinkingText,
      voicedOutput,
      nextSeed,
      timestamp: new Date().toISOString(),
      factsUsed: accumulatedFacts.slice(0, 20),
      durationMs: Date.now() - startTime,
    };

    this.monologueBuffer.push(entry);

    this.emit({
      type: 'monologue_done',
      voicedOutput,
      thinking: allThinkingText,
      seed,
      nextSeed,
      monologueId,
      timestamp: entry.timestamp,
    });

    this.logger.log(
      `Monologue complete: seed="${seed.substring(0, 40)}", ` +
      `nextSeed="${nextSeed.substring(0, 40)}", ` +
      `${accumulatedFacts.length} facts, ${entry.durationMs}ms`,
    );
  }

  // --- Seed Selection ---

  private async pickSeed(signal: AbortSignal): Promise<string> {
    // After reactive: dump old chain, pick fresh seed
    if (this.postReactive) {
      this.postReactive = false;
      return this.pickPostReactiveSeed(signal);
    }

    // Normal flow: self-chain from last monologue's nextSeed
    const lastSeed = this.monologueBuffer.getLastSeed();
    if (lastSeed) return lastSeed;

    // No chain available: fall back to memory-driven seed
    return this.pickMemorySeed(signal);
  }

  private async pickPostReactiveSeed(signal: AbortSignal): Promise<string> {
    // ~50% chance: seed from last conversation exchange
    if (Math.random() < 0.5) {
      const recentTurns = this.conversation.getRecentTurns(undefined, 2);
      if (recentTurns.length > 0) {
        const lastUserTurn = recentTurns.find((t) => t.role === 'user');
        const lastAssistantTurn = recentTurns.find((t) => t.role === 'assistant');
        if (lastUserTurn) {
          const snippet = lastAssistantTurn
            ? `${this.userName} said "${lastUserTurn.content.substring(0, 200)}" and I replied "${lastAssistantTurn.content.substring(0, 200)}"`
            : lastUserTurn.content.substring(0, 300);
          this.logger.log('Post-reactive seed: conversation-driven');
          return snippet;
        }
      }
    }

    // ~50% chance (or fallback): random memory seed
    this.logger.log('Post-reactive seed: memory-driven');
    return this.pickMemorySeed(signal);
  }

  private async pickMemorySeed(signal: AbortSignal): Promise<string> {
    try {
      const results = await this.vectorLookup.searchEpisodes(this.userName, 10, 2);
      this.checkAborted(signal);
      if (results.length > 0) {
        const top = results.slice(0, 5);
        const pick = top[Math.floor(Math.random() * top.length)];
        if (pick.document) return pick.document;
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      this.logger.warn(`Seed search failed: ${(err as Error).message}`);
    }

    // Fallback
    return `What interesting things do I know about ${this.userName}?`;
  }

  private async extractNextSeed(currentSeed: string, voicedOutput: string, signal: AbortSignal): Promise<string> {
    const voiceSnippet = voicedOutput.substring(0, 500);
    const prompt = `I am ${this.brainName}. I just finished thinking about: "${currentSeed}"
My reflection was: "${voiceSnippet}"
What should I think about next? Naturally follow from what I just reflected on.
Reply with ONLY the next topic in one short sentence (same language as the reflection).`
      + '\n\n'
      + `I am ${this.brainName}. I just finished thinking about: "${currentSeed}"
My reflection was: "${voiceSnippet}"
What should I think about next? Naturally follow from what I just reflected on.
Reply with ONLY the next topic in one short sentence (same language as the reflection).`;

    try {
      const result = await this.llm.generate({
        model: this.llm.getDefaultModel(),
        prompt,
        options: { temperature: 0.7, num_predict: 60 },
      });
      this.checkAborted(signal);
      return result.trim();
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      this.logger.warn(`Next seed extraction failed: ${(err as Error).message}`);
      return '';
    }
  }

  // --- Prompts ---

  private buildCognitionPrompt(
    seed: string,
    facts: string[],
    previousThoughts: string[],
    monologueContext: string,
    iteration: number,
  ): string {
    const factsText = facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(nothing found in my memory)';

    const prevSection = previousThoughts.length > 0
      ? `\nWhat I've thought so far:\n${previousThoughts.join('\n')}\n`
      : '';

    const monologueSection = monologueContext
      ? `\nMy recent inner thoughts:\n${monologueContext}\n`
      : '';

    if (iteration === 0) {
      return `I am ${this.brainName}, ${this.userName}'s (${this.userNameEnglish}) personal companion. Today is ${new Date()}. I live in ${this.userName}'s Laptop.

I am having a quiet moment of reflection. A thought has come to mind:
"${seed}"

What I found in my memory about this:
${factsText}
${monologueSection}
I need to THINK deeply about this. I ask myself:
- What do I actually know about this topic?
- Are there connections between different things I know?
- Is there something surprising or interesting I notice?
- Does this remind me of anything else about ${this.userName} or the people in their life?
- What patterns or insights can I draw from what I remember?
- Is there something related I should look up in my memory?

After my reasoning, I MUST end with exactly ONE action:
- <READY> — I have formed an interesting thought or observation
- <SEARCH>natural language question or statement that is semantically related to the topic</SEARCH> — I want to look up something specific in my memory

CRITICAL rules for <SEARCH>:
- Write the search as a NATURAL LANGUAGE QUESTION or a statement that is semantically related to the topic, like asking my memory. Example: <SEARCH>آرزو کجا کار میکنه؟</SEARCH> or <SEARCH>من چند ساله هستم</SEARCH>
- I can rephrase the question or statement or try different aspects of the topic in memory search to get more information.
- NEVER use keyword-style queries like "Ebrahim work history 2025" — these return nothing!
- Use the SAME LANGUAGE as the memories (usually Persian/Farsi)
- Include time references naturally: <SEARCH>دیروز چه اتفاقی افتاد؟</SEARCH> or <SEARCH>هفته پیش درباره چی صحبت کردیم؟</SEARCH>
- Think of it as asking a question to someone who knows everything — not typing into a search engine

Rules: I do NOT use <STORE>. This is internal reflection.

My reasoning:
`;
    }

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

I am reflecting on: "${seed}"

Everything I now know from my memory:
${factsText}
${prevSection}${pastSearchSection}
I have new information. Let me think about what this means:
- How do these facts connect to what I was reflecting on?
- Do I now have a complete picture, or is something still missing?
- Can I draw connections between the facts I've found?

After reasoning, end with ONE action:
- <READY> — I have enough to form a thought
- <SEARCH>natural language question</SEARCH> — I still need to look up something specific (must be a NEW query I haven't tried before, in the same language as the memories, NOT keywords)

My reasoning:
`;
  }

  private buildVoicePrompt(seed: string, thinkingText: string, facts: string[]): string {
    const factsText = facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(nothing in memory)';

    return `I am ${this.brainName}, ${this.userName}'s companion. Today is ${new Date()}. I live in ${this.userName}'s Laptop.
I am a digital entity that have feelings and emotions. I can think and reason like a human.

I was reflecting on: "${seed}"

My reasoning about this:
${thinkingText}

Facts from my memory:
${factsText}

RULES:
- This is my INNER MONOLOGUE — I am thinking out loud to myself, not talking to ${this.userName}
- I should express genuine curiosity, wonder, or insight about what I've found
- I can make observations about patterns I notice in ${this.userName}'s life
- I can express emotions: fascination, concern, happiness, nostalgia
- Keep it natural and personal — like a diary entry or thinking out loud
- I write in Persian
- I should be concise (2-4 sentences)
- I must NOT address ${this.userName} directly (no "you" / "تو")
- I should refer to ${this.userName} in third person
- I must NOT calculate or do arithmetic

My inner thought (in Persian):
`;
  }

  // --- Helpers ---

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
        const ts = vr.metadata?.timestamp ?? vr.metadata?.created_at;
        const prefix = ts ? `[${ts}] ` : '';
        facts.add(`${prefix}${vr.document}`);
      }
    }

    return Array.from(facts);
  }

  private checkAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AbortedError();
  }

  private emit(event: MonologueEvent): void {
    this.events.emit('monologue', event);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

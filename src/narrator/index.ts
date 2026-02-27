/**
 * Narrator Module
 *
 * The Narrator is the integrative voice of the coaching identity.
 * It sits alongside the social-self agents managed by lettabot,
 * periodically synthesizing reference material and conversation
 * experience into shared coaching philosophy blocks.
 *
 * Vocabulary (from McAdams' Narrative Identity):
 * - Author: the user who curates reference material and values
 * - Agents (social selves): 1:1 coaching relationships with athletes
 * - Narrator: this module — integrates across agents into coherent identity
 * - Protagonist: the coaching identity that athletes experience (shared blocks)
 */

export { ensureNarrator, loadNarratorCache, type NarratorState } from './setup.js';
export { ingestReferenceFiles } from './ingest.js';
export { triggerSynthesis, type SynthesisOptions } from './synthesize.js';
export { NarratorScheduler, type NarratorSchedulerConfig } from './scheduler.js';
export { NARRATOR_SYSTEM_PROMPT } from './system-prompt.js';

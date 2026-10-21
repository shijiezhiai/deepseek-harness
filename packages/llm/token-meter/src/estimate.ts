/**
 * Class-aware density heuristic token pricing shared by the meter service and
 * the pure context-breakdown projection, so both surfaces price identical
 * content to identical numbers.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/**
 * Tokens per CJK ideograph or CJK punctuation character. A Chinese character
 * commonly tokenizes to about one token, where the fixed Latin density
 * charges it a quarter of one; the split keeps mixed messages priced by
 * character class instead of one run rate.
 */
const CJK_CHARS_PER_TOKEN = 1

/** CJK Unified Ideographs (U+4E00–U+9FFF) plus common CJK punctuation. */
const CJK_IDEOGRAPH = /\p{Script=Han}/u
const CJK_PUNCTUATION = /[\u3000-\u303F\uFF01-\uFF60]/u

/** Tokens for one text run under the given chars-per-token density. */
function runTokens(length: number, charsPerToken: number): number {
  return Math.ceil(length / charsPerToken)
}

/**
 * Price a text run by character class: CJK ideographs and CJK punctuation cost
 * {@link CJK_CHARS_PER_TOKEN} each, everything else the fixed Latin
 * {@link CHARS_PER_TOKEN}. A contiguous non-CJK run prices exactly as the
 * single-rate rule did, so Latin-only text is unchanged.
 * @param text - text to price without mutation.
 * @returns heuristic tokens for the run.
 */
export function estimateTextTokens(text: string): number {
  let total = 0
  let latinRun = 0
  let cjkRun = 0
  for (const character of text) {
    if (CJK_IDEOGRAPH.test(character) || CJK_PUNCTUATION.test(character)) {
      total += runTokens(latinRun, CHARS_PER_TOKEN)
      latinRun = 0
      cjkRun += CJK_CHARS_PER_TOKEN
      continue
    }
    total += runTokens(cjkRun, CJK_CHARS_PER_TOKEN)
    cjkRun = 0
    latinRun += 1
  }
  return total + runTokens(latinRun, CHARS_PER_TOKEN) + runTokens(cjkRun, CJK_CHARS_PER_TOKEN)
}

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * class-aware heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed. Image offload marks do not
 * change this reference-only heuristic; route pricing owns their placeholders.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(reference))
  }
  return BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(block))
}

/**
 * Price content blocks recursively under the class-aware density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateTextTokens(block.name)
          + estimateTextTokens(block.arguments)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the class-aware heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: the `system/message` surface node's text.
 * Adapters serialize the prompt as a plain string — a system-role message or
 * the request's system field — not as a typed content block, so the price is
 * text density plus role framing with no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content ("no system prompt").
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let tokens = 0
  for (const block of message.content) {
    tokens += block.type === 'text' ? estimateTextTokens(block.text) : estimateTextTokens(JSON.stringify(block))
  }
  return tokens + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the class-aware heuristic; a
 *   system-role message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return estimateTextTokens(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
}

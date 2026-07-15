/**
 * The zero-key `audit` path (a seed of the M10 orchestrator).
 *
 * Thin: gather inputs via the fetcher (M2), score them with the pure audit
 * engine (M3). No LLM, no keys. The full `check` orchestrator lands with M10.
 */
import {
  type AuditReport,
  buildAuditReport,
  gatherAuditInput,
} from '../audit/index.js';
import { type Fetcher, createFetcher } from '../fetcher/index.js';

export interface RunAuditOptions {
  /** Injected for tests; defaults to a real-network fetcher. */
  fetcher?: Fetcher;
  samplePages?: number;
}

export async function runAudit(
  domain: string,
  opts: RunAuditOptions = {},
): Promise<AuditReport> {
  const fetcher = opts.fetcher ?? createFetcher();
  const input = await gatherAuditInput(domain, fetcher, {
    samplePages: opts.samplePages,
  });
  return buildAuditReport(input);
}

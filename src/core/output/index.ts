/**
 * Public API of the output module. Import from `core/output`.
 *
 * M8 (the data contract): `buildEnvelope` -> the stable {@link VisibilityEnvelope}
 * every consumer reads, snapshot persistence + `diffEnvelopes`, and the
 * `--fail-under` gate. M9 (seed): plain-text/JSON renderers over that contract.
 */
export * from './envelope.js';
export * from './snapshot.js';
export * from './diff.js';
export * from './failunder.js';
export * from './terminal.js';

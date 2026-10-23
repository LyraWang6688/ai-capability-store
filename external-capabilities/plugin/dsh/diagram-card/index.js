/**
 * Host half of the diagram-card bundle.
 *
 * Client-only capability: rendering happens entirely in `client.js`.
 * There is no HTTP route, no subprocess, no credential, and no filesystem
 * access here — so this half intentionally exposes nothing.
 */

export const name = 'dsh-diagram-card';

export function apply() {
  // Intentionally empty. See client.js.
}

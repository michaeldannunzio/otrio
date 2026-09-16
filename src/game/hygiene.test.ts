/**
 * Structural guards on this directory.
 *
 * Neither of these tests is about Otrio. They protect two properties that are
 * easy to break by accident and expensive to diagnose afterwards, because both
 * failure modes surface far away from the edit that caused them.
 */

import { describe, expect, it } from 'vitest';

/**
 * Every `.ts` file in this directory, read through Vite's glob rather than
 * `node:fs` so the test needs no Node globals (the app tsconfig's `types` list
 * deliberately omits `node`). Comments are blanked out first, so a specimen
 * import inside a doc comment is not mistaken for a real one.
 */
const SOURCES = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function engineSources(includeTests: boolean): [string, string][] {
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return Object.entries(SOURCES)
    .filter(([path]) => includeTests || !path.includes('.test.'))
    .map(([path, source]) => [path.replace('./', ''), strip(source)] as [string, string]);
}

describe('module hygiene', () => {
  /**
   * Two independent reasons every relative import here needs its extension:
   *
   *  - The Node server can load this engine with `--experimental-strip-types`
   *    and a bare `await import()`. Node's ESM resolver does not guess
   *    extensions, so an extensionless specifier throws ERR_MODULE_NOT_FOUND —
   *    which `server/src/rules.ts` deliberately treats as "file does not
   *    exist" and swallows, leaving a boot failure that points nowhere near
   *    the real cause.
   *  - The server's `nodenext` tsconfig rejects extensionless relative imports
   *    outright (TS2835), so it also fails the typecheck.
   *
   * The repo convention is therefore `.ts` on every relative specifier,
   * cross-directory ones included — see `server/src/rules.ts` importing
   * `'../../src/net/protocol.ts'`.
   */
  it('uses explicit .ts extensions on every relative import', () => {
    const offenders: string[] = [];
    for (const [file, source] of engineSources(true)) {
      for (const match of source.matchAll(/from\s+'(\.[^']*)'/g)) {
        if (!match[1].endsWith('.ts')) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The rules engine must stay standalone: pure, dependency-free, and
   * importable by the browser, the Node server and a test with no other part
   * of the app loaded. A value import that escapes this directory would drag
   * a whole layer in behind it.
   *
   * `import type` is exempt — it is fully erased under `verbatimModuleSyntax`
   * and never resolved at runtime.
   */
  it('keeps the engine free of runtime dependencies outside src/game', () => {
    const leaks: string[] = [];
    for (const [file, source] of engineSources(false)) {
      for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
        const spec = match[1];
        if (spec.startsWith('./')) continue;
        leaks.push(`${file}: ${spec}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  /**
   * The wire projection lives in `src/net/referee.ts` and only there. A second
   * engine-to-`GameSnapshot` projection in this directory could disagree with
   * it, which is the failure mode that produced four conflicting player
   * palettes in this project.
   */
  it('contains no engine-to-wire projection', () => {
    const offenders: string[] = [];
    for (const [file, source] of engineSources(false)) {
      if (/GameSnapshot|from\s+'\.\.\/net\//.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

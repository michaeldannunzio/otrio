import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

/**
 * Lint rules for Otrio.
 *
 * This is not a generic preset. Every rule that is turned on or off below maps
 * to something that actually went wrong while this project was built by ten
 * agents in parallel, or to a rule in ~/.claude/CLAUDE.md. The point is to make
 * a linter enforce what a prose standard cannot: prose gets skimmed.
 *
 * Formatting is Prettier's job alone. `eslint-config-prettier` goes last and
 * switches off every stylistic rule, so the two can never disagree.
 */

/* -------------------------------------------------------------------------- *
 * Local rule: imports the bundler cannot follow
 *
 * House rule 2, and the most expensive bug in this project's history.
 *
 * `import(/* @vite-ignore *\/ someVariable)` compiles, passes tsc, and produces
 * a green build — while Vite emits no chunk for it and never rewrites the path.
 * At runtime the specifier resolves against the emitted chunk's URL, 404s, and
 * the surrounding `catch` swallows it. A production build of a 3D game came out
 * with 71 modules and no three.js in it, and nothing failed loudly.
 *
 * Two things make an import unbundlable, and this catches both:
 *   1. a specifier that is not a string literal, so static analysis cannot read it
 *   2. an explicit `@vite-ignore`, which tells the bundler to skip it even when
 *      the specifier IS a literal
 *
 * It is a custom rule rather than `no-warning-comments` matching the text
 * `@vite-ignore`, because the codebase now contains several comments that
 * *explain* this bug. Banning the marker by text would flag the documentation
 * of the bug along with the bug. This looks only at real import expressions.
 */
const noUnbundlableImport = {
  meta: {
    type: 'problem',
    docs: { description: 'Dynamic imports must be statically analysable by the bundler.' },
    schema: [],
    messages: {
      notLiteral:
        'Dynamic import specifier must be a string literal. A specifier the bundler cannot read statically is a dependency it will not ship — the import will 404 at runtime in a build that exited 0. If the module does not exist yet, stop and say so (house rule 2) rather than probing for it.',
      viteIgnore:
        '`@vite-ignore` tells the bundler not to follow this import, so no chunk is emitted for it. This is how three.js went unbundled. Remove it and use a literal specifier.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      ImportExpression(node) {
        if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') {
          context.report({ node, messageId: 'notLiteral' });
        }
        const inner = sourceCode.getCommentsBefore(node.source);
        if (inner.some((c) => c.value.includes('@vite-ignore'))) {
          context.report({ node, messageId: 'viteIgnore' });
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-*/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      'server/dist/**',
      '*.tsbuildinfo',
    ],
  },

  js.configs.recommended,

  /* Type-aware linting. `no-floating-promises` and friends cannot work without
     a TypeScript program. `projectService` picks the right tsconfig per file,
     which matters here because there are three of them (app / node / server)
     targeting different runtimes. */
  ...tseslint.configs.recommendedTypeChecked,
  comments.recommended,

  /* Not speculative: the scene and UI code already carried five
     `eslint-disable-next-line react-hooks/exhaustive-deps` comments before any
     linter existed here, so the codebase was already written against this
     plugin. Without it those comments are hard errors ("rule not found").

     It also earns its place on merit — this is an r3f app where `useEffect`
     and `useFrame` closures capture scene objects, and a stale dep array there
     produces a board that silently stops updating rather than a crash. */
  /* Deliberately NOT `reactHooks.configs.flat.recommended`. In v7 both presets
     bundle the whole React Compiler rule set — immutability, purity,
     set-state-in-effect, static-components and a dozen more, mostly at 'error'.
     Those are a real adoption decision with real work behind them, and turning
     them on here would drop ~17 errors into the scene and UI owners' files
     unasked. That decision is theirs to make, not this config's.

     So: register the plugin, enable the two rules the codebase was already
     written against, and leave the rest available for whoever opts in.
     (Also note `.configs.flat[...]` rather than `.configs[...]` — the
     top-level entries are the legacy eslintrc shape, whose
     `plugins: ['react-hooks']` array ESLint 10 rejects outright.) */
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      /* A genuine correctness rule with essentially no false positives: a hook
         called conditionally is always a bug. */
      'react-hooks/rules-of-hooks': 'error',
      /* Warn, not error: the five pre-existing disable comments show the
         owners have already made considered calls here. */
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { local: { rules: { 'no-unbundlable-import': noUnbundlableImport } } },
    rules: {
      /* TypeScript already resolves identifiers, and does it far better —
         a broken import block in rtcTransport.ts produced 119 TS2304s in one
         run. `no-undef` on top of that only adds false positives, because it
         does not understand type-space names or TS's lib definitions. This is
         typescript-eslint's own standing recommendation. */
      'no-undef': 'off',

      'local/no-unbundlable-import': 'error',

      /* House rule 11: no `any` without a comment justifying it.
         `any` is a warning rather than an error so it does not block a build,
         but silencing it requires saying why — see require-description below. */
      '@typescript-eslint/no-explicit-any': 'warn',

      /* The justification half of the rule above. An `eslint-disable` with no
         reason is how a warning becomes permanent. */
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: ['eslint-enable'] },
      ],
      '@eslint-community/eslint-comments/no-unused-disable': 'error',

      /* `ts-expect-error` is fine; an unexplained one is not. And `ts-ignore`
         is never fine, because it does not complain when it stops being needed. */
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true },
      ],

      /* `_`-prefixed is the established escape hatch in this codebase — several
         animation updaters legitimately ignore a parameter they are handed. */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      /* The project sets `verbatimModuleSyntax`, so type-only imports must be
         marked or the emitted JS tries to import a type at runtime. Inline
         style (`import { type Foo, bar }`) matches what the codebase uses. */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      /* House rule 2, corollary: crash early. An unawaited promise is a failure
         that happens somewhere else, later, with no stack worth reading. */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /* A `catch {}` that swallows a structural failure is worse than no catch
         at all — it is precisely what hid the unbundled-scene bug. */
      'no-empty': ['error', { allowEmptyCatch: false }],

      /* Colour 0 is a real player (see CLAUDE.md). `==` coercion around falsy
         zeroes is a live hazard in this codebase specifically. */
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-console': ['warn', { allow: ['warn', 'error'] }],

      /* ---------------------------------------------------------------- *
       * Graded down to warnings, deliberately.
       *
       * These come from `recommendedTypeChecked` and are real — the 75
       * unnecessary assertions below are genuine redundant casts, not false
       * positives (spot-checked: `easeOutCubic as Easing`, where the value is
       * already an `Easing`). But they are cleanliness, not correctness, and
       * they land in five different owners' files.
       *
       * A lint that fails with 167 errors on its first run is a lint everyone
       * turns off. Keeping the rules above as errors and these as warnings
       * means `npm run lint` fails only on things that can actually break the
       * app, while the tidying stays visible. Promote them to 'error' once
       * someone has done a cleanup pass.
       * ---------------------------------------------------------------- */
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-unsafe-enum-comparison': 'warn',

      /* The `no-unsafe-*` family fires wherever an `any` flows through. Since
         `no-explicit-any` is itself a warning, making its consequences errors
         would be inconsistent. */
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
    },
  },

  /* --------------------------------------------------------------------- *
   * The colour-zero landmine
   *
   * `PlayerColor = 0 | 1 | 2 | 3`, and colour 0 is purple — a real player whose
   * identity is a falsy number. So `if (cell.small)` silently treats every
   * purple piece as an empty slot, and `if (colour)` silently drops purple from
   * whatever it guards. Both read as completely ordinary JavaScript. CLAUDE.md
   * names this as the thing most likely to trip someone up, and a type checker
   * cannot catch it: the code is perfectly well-typed, it just means something
   * other than what it says.
   *
   * Scoped to the rules engine and the wire layer, which is where colours are
   * handled as raw numbers. The UI deals in already-resolved values.
   *
   * The options matter more than the rule does. `allowNumber` defaults to
   * TRUE, which permits `if (someNumber)` and would miss this entirely — it
   * has to be turned off explicitly or the rule is decorative here. The
   * string/object/any allowances stay on: they are not this hazard, and
   * leaving them off buries the signal in noise about `if (name)`.
   * --------------------------------------------------------------------- */
  {
    files: ['src/game/**/*.ts', 'src/net/**/*.ts'],
    rules: {
      '@typescript-eslint/strict-boolean-expressions': [
        'warn',
        {
          allowNumber: false, // the point of the rule
          allowNullableNumber: false, // `PlayerColor | null` — `cell.small`
          allowString: true,
          allowNullableString: true,
          allowNullableObject: true,
          allowNullableBoolean: true,
          allowAny: true,
        },
      ],
    },
  },

  /* Tests: assertions on partially-built fixtures make strict promise and
     non-null rules more noise than signal. */
  {
    files: ['**/*.{test,spec}.{ts,tsx}', 'src/game/test-helpers.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  /* Build tooling and one-shot scripts are not part of a TS project, so they
     get untyped linting rather than a parser error. */
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.{js,mjs}', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false } },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['server/**/*.ts', 'scripts/**'],
    rules: { 'no-console': 'off' }, // a server's log IS its interface
  },

  /* Must stay last: turns off everything Prettier owns. */
  prettier,
);

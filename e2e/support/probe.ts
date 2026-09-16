import type { Page } from '@playwright/test';

/**
 * Reaching into the running three.js renderer from a test.
 *
 * three.js dispatches an `observe` event on `window.__THREE_DEVTOOLS__` from the
 * `WebGLRenderer` and `Scene` constructors, if such an object exists. That is
 * the hook the browser extension uses, and it is the only supported way to get
 * at the live renderer without the app exporting a global itself — which it
 * should not do just to be testable.
 *
 * The listener has to be installed before any app code runs, so it goes in via
 * `addInitScript`. It is inert if three never loads.
 */

declare global {
  interface Window {
    __otrioProbe?: { renderers: unknown[]; scenes: unknown[] };
    __THREE_DEVTOOLS__?: EventTarget;
  }
}

/** Serialised into the page by `installThreeProbe`. Must be self-contained. */
function threeProbeInit(): void {
  const state: { renderers: unknown[]; scenes: unknown[] } = { renderers: [], scenes: [] };
  window.__otrioProbe = state;
  const hook = new EventTarget();
  hook.addEventListener('observe', (event) => {
    const detail = (event as CustomEvent<{ isScene?: boolean }>).detail;
    if (detail && detail.isScene) state.scenes.push(detail);
    else state.renderers.push(detail);
  });
  window.__THREE_DEVTOOLS__ = hook;
}

export async function installThreeProbe(page: Page): Promise<void> {
  await page.addInitScript(threeProbeInit);
}

/**
 * Make WebGL unavailable, the way an old phone or a browser with hardware
 * acceleration switched off makes it unavailable.
 *
 * `BoardStage.hasWebGL()` probes by calling `canvas.getContext('webgl2')` and
 * `('webgl')`, so returning null from both is exactly the condition it tests
 * for. Patching the prototype rather than the Canvas element covers the probe
 * and anything three.js would try afterwards.
 */
export async function disableWebGL(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // Signature is heavily overloaded; the cast is the narrowest way to keep
    // the 2d path working while refusing every WebGL variant.
    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return (original as (this: HTMLCanvasElement, ...a: unknown[]) => unknown).call(
        this,
        kind,
        ...rest,
      );
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

export interface GlReport {
  /** A WebGL context can be created at all, independent of the app. */
  webgl: boolean;
  /** `WEBGL_debug_renderer_info` — tells us SwiftShader vs a real driver. */
  driver: string | null;
  canvasCount: number;
  rendererCount: number;
  sceneCount: number;
  /**
   * Draw calls in the most recent frame. three.js resets `info` at the top of
   * every `render()`, so under `frameloop="demand"` this is the last frame the
   * app actually drew — which is precisely the question "did it draw".
   */
  drawCalls: number | null;
  triangles: number | null;
  geometries: number | null;
  textures: number | null;
  programs: number | null;
  /**
   * `scene.environment` is the PMREM bake from `useStudioEnvironment`. It has
   * no fallback: without it every PBR material in the scene reads as unlit
   * clay. Mapping 306 is three's CubeUVReflectionMapping, i.e. a real PMREM
   * target rather than a raw texture someone assigned by hand.
   */
  hasEnvironment: boolean;
  environmentMapping: number | null;
  contextLost: boolean | null;
  canvasPixels: { width: number; height: number } | null;
}

/** Read the renderer's own accounting of the last frame. */
export async function readGl(page: Page): Promise<GlReport> {
  return page.evaluate(() => {
    /* Shapes are three.js internals reached through the devtools hook, so they
       are described here rather than imported: the test must not pull three
       into its own bundle just to name a field. */
    interface RendererLike {
      info?: {
        render?: { calls?: number; triangles?: number };
        memory?: { geometries?: number; textures?: number };
        programs?: unknown[] | null;
      };
      getContext?: () => { isContextLost?: () => boolean } | null;
    }
    interface SceneLike {
      environment?: { mapping?: number } | null;
    }

    const state = window.__otrioProbe ?? { renderers: [], scenes: [] };
    const renderer = state.renderers[0] as RendererLike | undefined;
    const scenes = state.scenes as SceneLike[];
    const withEnv = scenes.find((s) => !!s.environment);
    const canvas = document.querySelector('canvas');

    const probe = document.createElement('canvas');
    const gl =
      (probe.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (probe.getContext('webgl') as WebGLRenderingContext | null);
    let driver: string | null = null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      driver = ext
        ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
    }

    return {
      webgl: !!gl,
      driver,
      canvasCount: document.querySelectorAll('canvas').length,
      rendererCount: state.renderers.length,
      sceneCount: scenes.length,
      drawCalls: renderer?.info?.render?.calls ?? null,
      triangles: renderer?.info?.render?.triangles ?? null,
      geometries: renderer?.info?.memory?.geometries ?? null,
      textures: renderer?.info?.memory?.textures ?? null,
      programs: renderer?.info?.programs?.length ?? null,
      hasEnvironment: !!withEnv,
      environmentMapping: withEnv?.environment?.mapping ?? null,
      contextLost: renderer?.getContext?.()?.isContextLost?.() ?? null,
      canvasPixels: canvas ? { width: canvas.width, height: canvas.height } : null,
    };
  });
}

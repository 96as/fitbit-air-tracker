import { AppState } from 'react-native';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { initLlama, type LlamaContext } from 'llama.rn';
import {
  MEAL_ANALYSIS_PROMPT,
  MEAL_ANALYSIS_RETRY_PROMPT,
  MEAL_ANALYSIS_SCHEMA,
  parseMealAnalysis,
  type MealAnalysis,
} from '@fitbit-air-tracker/core';
import { isModelInstalled, modelPaths } from './modelManager';
import { modelById } from './models';

/**
 * Photo → foods, fully on the phone (llama.rn = llama.cpp + mtmd, Metal GPU).
 * The photo is downscaled into the app's cache, analysed, and the scaled copy
 * deleted; nothing is uploaded anywhere. The model is loaded only for the
 * duration of one analysis and released afterwards to give the memory back.
 * Foreground only: if the app is backgrounded the run is stopped (iOS would
 * kill a multi-GB background process anyway).
 */

export class ModelNotReadyError extends Error {
  constructor() {
    super('The on-device food model is not downloaded yet.');
  }
}
export class AnalysisFailedError extends Error {}
export class AnalysisInterruptedError extends Error {}

const MAX_SIDE = 896;

export type AnalysisStage = 'preparing' | 'loading-model' | 'looking' | 'retrying' | 'done';

export async function analyzeMeal(
  photo: { uri: string; width?: number; height?: number },
  modelId: string,
  onStage?: (s: AnalysisStage) => void,
): Promise<MealAnalysis> {
  if (!isModelInstalled(modelId)) throw new ModelNotReadyError();
  if (AppState.currentState !== 'active') throw new AnalysisInterruptedError('App is not in the foreground.');
  const model = modelById(modelId);

  onStage?.('preparing');
  const scaled = await downscale(photo);
  let ctx: LlamaContext | undefined;
  let interrupted = false;
  const sub = AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      interrupted = true;
      void ctx?.stopCompletion().catch(() => undefined);
    }
  });

  try {
    onStage?.('loading-model');
    const paths = modelPaths(modelId);
    ctx = await initLlama({
      model: paths.model,
      n_ctx: model.nCtx,
      n_batch: 512,
      // Gemma vision tokens attend non-causally: the whole image must fit in one ubatch.
      n_ubatch: 512,
      n_gpu_layers: 99,
      use_mmap: true,
      use_mlock: false,
      ctx_shift: false,
    });
    const ok = await ctx.initMultimodal({ path: paths.mmproj, use_gpu: true, image_max_tokens: model.imageMaxTokens });
    if (!ok) throw new AnalysisFailedError('Could not start the vision part of the model.');
    if (interrupted) throw new AnalysisInterruptedError('Stopped because the app left the foreground.');

    const ask = async (prompt: string) => {
      const res = await ctx!.completion({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: scaled } },
              { type: 'text', text: prompt },
            ],
          },
        ],
        jinja: true,
        enable_thinking: false,
        n_predict: 384,
        temperature: 0.1,
        top_p: 0.9,
        response_format: { type: 'json_schema', json_schema: { strict: true, schema: MEAL_ANALYSIS_SCHEMA } },
      });
      if (interrupted) throw new AnalysisInterruptedError('Stopped because the app left the foreground.');
      return res.text;
    };

    onStage?.('looking');
    let parsed = parseMealAnalysis(await ask(MEAL_ANALYSIS_PROMPT));
    if (!parsed) {
      onStage?.('retrying');
      parsed = parseMealAnalysis(await ask(MEAL_ANALYSIS_RETRY_PROMPT));
    }
    if (!parsed) throw new AnalysisFailedError('The model did not return a usable food list.');
    onStage?.('done');
    return parsed;
  } finally {
    sub.remove();
    if (ctx) {
      await ctx.releaseMultimodal().catch(() => undefined);
      await ctx.release().catch(() => undefined);
    }
    try {
      const f = new File(scaled);
      if (f.exists && scaled !== photo.uri) f.delete();
    } catch {
      // ignore
    }
  }
}

/** Longest side → 896 px JPEG in the cache dir (fewer image tokens, faster, less RAM). */
async function downscale(photo: { uri: string; width?: number; height?: number }): Promise<string> {
  const w = photo.width ?? 0;
  const h = photo.height ?? 0;
  const ctx = ImageManipulator.manipulate(photo.uri);
  if (w > MAX_SIDE || h > MAX_SIDE || !w || !h) {
    ctx.resize(w >= h ? { width: MAX_SIDE } : { height: MAX_SIDE });
  }
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return out.uri;
}

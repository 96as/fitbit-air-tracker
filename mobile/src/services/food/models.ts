/**
 * On-device vision-language models the app can download (runtime: llama.rn /
 * llama.cpp + mtmd). Files come from Hugging Face, pinned to a commit, and are
 * verified by SHA-256 (= the LFS oid published by Hugging Face) after download.
 * See docs/FOOD.md for why these models and how the numbers were checked.
 */

export interface ModelFile {
  /** Local file name under <documents>/models/<id>/ */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface VisionModel {
  id: string;
  title: string;
  /** Short line for the picker. */
  summary: string;
  license: string;
  /** [language model GGUF, multimodal projector GGUF] */
  files: [ModelFile, ModelFile];
  /** Rough peak RAM while analysing a photo (weights mmap'd + projector + KV + compute buffers). */
  approxPeakRamGB: number;
  /** Max image tokens to request from the projector (lower = faster, less RAM). */
  imageMaxTokens: number;
  nCtx: number;
}

const HF = 'https://huggingface.co';

export const VISION_MODELS: VisionModel[] = [
  {
    id: 'gemma-4-e2b-q4',
    title: 'Gemma 4 E2B (recommended)',
    summary: "Google's small multimodal Gemma 4; best food recognition of the options here.",
    license: 'Apache-2.0',
    files: [
      {
        name: 'gemma-4-E2B-it-Q4_0.gguf',
        url: `${HF}/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf`,
        bytes: 2_841_481_184,
        sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
      },
      {
        name: 'mmproj-gemma-4-E2B-it-Q8_0.gguf',
        url: `${HF}/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/mmproj-gemma-4-E2B-it-Q8_0.gguf`,
        bytes: 557_368_064,
        sha256: '9406f99c16d68cda4f1f0552192dcc99021ea1fc6d2fd50b1dc3ccf30d04b292',
      },
    ],
    approxPeakRamGB: 4.0,
    imageMaxTokens: 280,
    nCtx: 2048,
  },
  {
    id: 'qwen3-vl-2b-q8',
    title: 'Qwen3-VL 2B (lighter)',
    summary: 'Smaller download and memory; use it if Gemma 4 is closed by iOS for memory.',
    license: 'Apache-2.0',
    files: [
      {
        name: 'Qwen3-VL-2B-Instruct-Q8_0.gguf',
        url: `${HF}/ggml-org/Qwen3-VL-2B-Instruct-GGUF/resolve/ea6a11058182570be6436b9a2e4ee7f7b49f908d/Qwen3-VL-2B-Instruct-Q8_0.gguf`,
        bytes: 1_834_427_296,
        sha256: 'b7802e29f71a9e5b5e3f83f613df898a2204342dcea71a231ea501d481813c39',
      },
      {
        name: 'mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf',
        url: `${HF}/ggml-org/Qwen3-VL-2B-Instruct-GGUF/resolve/ea6a11058182570be6436b9a2e4ee7f7b49f908d/mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf`,
        bytes: 445_053_056,
        sha256: '69066c8f279ec85ff48ab4059f6ebba0d2932ca57667f2bbdac7d9805bca9e7b',
      },
    ],
    approxPeakRamGB: 2.8,
    imageMaxTokens: 384,
    nCtx: 2048,
  },
];

export function modelById(id: string): VisionModel {
  return VISION_MODELS.find((m) => m.id === id) ?? VISION_MODELS[0]!;
}

export function modelBytes(m: VisionModel): number {
  return m.files[0].bytes + m.files[1].bytes;
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} KB`;
}

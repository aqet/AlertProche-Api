/**
 * Moteur de reconnaissance faciale : SCRFD (détection) + ArcFace MobileFaceNet
 * (embedding 512 dims), exécuté en WebAssembly via `onnxruntime-web`.
 *
 * Aucun binaire natif : le même code tourne en local (Windows/macOS) et sur
 * Vercel (Linux). Les fichiers de modèles et le runtime WASM sont copiés dans
 * `src/faces/models/` et embarqués dans le build.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import * as sharp from 'sharp';
import * as ort from 'onnxruntime-web';

import {
  DET_INPUT_SIZE,
  DET_STRIDES,
  FaceEmbedding,
  alignFace,
  decodeStride,
  filterFaces,
  NMS_THRESHOLD,
  nonMaxSuppression,
  REC_INPUT_SIZE,
} from './face-pipeline';

/** Taille maximale de l'image analysée (au-delà, on redimensionne). */
const MAX_IMAGE_SIZE = 1280;

const DET_MODEL = 'det_500m.onnx';
const REC_MODEL = 'w600k_mbf.onnx';
const WASM_GLUE = 'ort-wasm-simd-threaded.mjs';
const WASM_BINARY = 'ort-wasm-simd-threaded.wasm';

/**
 * Cherche le dossier des modèles. Le chemin diffère selon le contexte :
 * `dist/faces` après `nest build`, `src/faces` en développement, et la racine
 * du projet sur Vercel (fichiers inclus via `includeFiles`).
 */
export function resolveModelsDir(): string | null {
  const candidates = [
    join(__dirname, 'models'),
    join(process.cwd(), 'dist', 'faces', 'models'),
    join(process.cwd(), 'src', 'faces', 'models'),
  ];
  return (
    candidates.find((dir) => existsSync(join(dir, DET_MODEL))) ?? null
  );
}

export interface FaceExtractionResult {
  faces: FaceEmbedding[];
  image: { width: number; height: number };
}

export class FaceEngine {
  private detSession: ort.InferenceSession | null = null;
  private recSession: ort.InferenceSession | null = null;
  private initPromise: Promise<void> | null = null;

  /** Les inférences WASM sont sérialisées : le backend n'est pas conçu pour
   *  exécuter plusieurs `run()` simultanés sur le même fil. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelsDir: string) {}

  get isAvailable(): boolean {
    return (
      existsSync(join(this.modelsDir, DET_MODEL)) &&
      existsSync(join(this.modelsDir, REC_MODEL))
    );
  }

  /** Charge les modèles une seule fois (idempotent). */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (!this.isAvailable) {
      throw new Error(
        `Modèles de reconnaissance faciale introuvables dans ${this.modelsDir}`,
      );
    }

    // Le runtime WASM est chargé depuis le même dossier que les modèles :
    // indispensable sur Vercel, où le paquet npm n'est pas résolu au runtime.
    // `mjs` doit être une URL `file://` (import dynamique Node), `wasm` un
    // chemin absolu classique (lecture fs par le glue Emscripten).
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = {
      mjs: pathToFileURL(join(this.modelsDir, WASM_GLUE)).href,
      wasm: join(this.modelsDir, WASM_BINARY),
    };

    this.detSession = await ort.InferenceSession.create(
      join(this.modelsDir, DET_MODEL),
    );
    this.recSession = await ort.InferenceSession.create(
      join(this.modelsDir, REC_MODEL),
    );
  }

  /**
   * Exécute une inférence à vide sur les deux modèles pour forcer la
   * compilation des noyaux WASM. À appeler une fois au démarrage.
   */
  async warmUp(): Promise<void> {
    await this.initialize();

    const canvasSize = DET_INPUT_SIZE;
    const detInput = new Float32Array(3 * canvasSize * canvasSize);
    await this.detSession!.run({
      [this.detSession!.inputNames[0]]: new ort.Tensor('float32', detInput, [
        1,
        3,
        canvasSize,
        canvasSize,
      ]),
    });

    const recInput = new Float32Array(3 * REC_INPUT_SIZE * REC_INPUT_SIZE);
    await this.recSession!.run({
      [this.recSession!.inputNames[0]]: new ort.Tensor('float32', recInput, [
        1,
        3,
        REC_INPUT_SIZE,
        REC_INPUT_SIZE,
      ]),
    });
  }

  /**
   * Détecte les visages d'une image et calcule leur embedding.
   * Les visages sont triés du plus grand au plus petit (le principal d'abord).
   */
  extractFaces(buffer: Buffer): Promise<FaceExtractionResult> {
    const run = () => this.doExtractFaces(buffer);
    // Chaînage : une erreur ne doit pas bloquer les requêtes suivantes.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async doExtractFaces(buffer: Buffer): Promise<FaceExtractionResult> {
    await this.initialize();

    const decoded = await sharp(buffer)
      .rotate()
      .resize({
        width: MAX_IMAGE_SIZE,
        height: MAX_IMAGE_SIZE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = decoded.info;
    if (channels !== 3) {
      throw new Error(`Format d'image inattendu (${channels} canaux)`);
    }

    const faces = await this.detect(decoded.data, width, height);
    const results: FaceEmbedding[] = [];

    for (const face of faces) {
      const chw = alignFace(decoded.data, width, height, face.kps);
      const output = await this.recSession!.run({
        [this.recSession!.inputNames[0]]: new ort.Tensor('float32', chw, [
          1,
          3,
          REC_INPUT_SIZE,
          REC_INPUT_SIZE,
        ]),
      });

      const raw = output[this.recSession!.outputNames[0]].data as Float32Array;
      let norm = 0;
      for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
      norm = Math.sqrt(norm) || 1;

      results.push({
        score: face.score,
        bbox: face.bbox,
        width: Math.round(face.width),
        height: Math.round(face.height),
        embedding: Array.from(raw, (value) => value / norm),
      });
    }

    // Visage principal en premier.
    results.sort((a, b) => b.width * b.height - a.width * a.height);
    return { faces: results, image: { width, height } };
  }

  /** Détection SCRFD sur un canevas 640 × 640 (ratio conservé). */
  private async detect(
    rgb: Buffer,
    width: number,
    height: number,
  ): Promise<ReturnType<typeof filterFaces>> {
    const canvasSize = DET_INPUT_SIZE;
    const detScale = Math.min(canvasSize / width, canvasSize / height);
    const dw = Math.max(1, Math.round(width * detScale));
    const dh = Math.max(1, Math.round(height * detScale));

    const resized = await sharp(rgb, {
      raw: { width, height, channels: 3 },
    })
      .resize({ width: dw, height: dh, fit: 'fill' })
      .raw()
      .toBuffer();

    // Canevas noir + normalisation (v − 127.5) / 128, planaire RGB.
    const plane = canvasSize * canvasSize;
    const input = new Float32Array(3 * plane);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const source = (y * dw + x) * 3;
        const target = y * canvasSize + x;
        input[target] = (resized[source] - 127.5) / 128;
        input[plane + target] = (resized[source + 1] - 127.5) / 128;
        input[2 * plane + target] = (resized[source + 2] - 127.5) / 128;
      }
    }

    const output = await this.detSession!.run({
      [this.detSession!.inputNames[0]]: new ort.Tensor('float32', input, [
        1,
        3,
        canvasSize,
        canvasSize,
      ]),
    });

    // Les sorties n'ont pas de noms stables : on les classe par forme
    // (scores [N,1], boîtes [N,4], points [N,10]) puis par nombre d'ancres
    // décroissant, ce qui correspond aux strides 8, 16 puis 32.
    const tensors = this.detSession!.outputNames.map((name) => output[name]);
    const byAnchorsDesc = (a: ort.Tensor, b: ort.Tensor) =>
      b.dims[0] - a.dims[0];

    const scores = tensors
      .filter((t) => t.dims.length === 2 && t.dims[1] === 1)
      .sort(byAnchorsDesc);
    const boxes = tensors
      .filter((t) => t.dims.length === 2 && t.dims[1] === 4)
      .sort(byAnchorsDesc);
    const landmarks = tensors
      .filter((t) => t.dims.length === 2 && t.dims[1] === 10)
      .sort(byAnchorsDesc);

    const faces = DET_STRIDES.flatMap((stride, index) =>
      decodeStride(
        scores[index].data as Float32Array,
        boxes[index].data as Float32Array,
        landmarks[index].data as Float32Array,
        canvasSize,
        stride,
        detScale,
      ),
    );

    return filterFaces(
      nonMaxSuppression(faces, NMS_THRESHOLD),
      width,
      height,
    );
  }
}

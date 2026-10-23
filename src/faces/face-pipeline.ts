/**
 * Fonctions pures du pipeline visage (aucune dépendance I/O) :
 * décodage SCRFD, NMS, estimation de transformation et alignement ArcFace.
 *
 * Séparées du service Nest pour rester testables et réutilisables par les
 * scripts de ré-indexation.
 */

export const DET_INPUT_SIZE = 640;
export const DET_STRIDES = [8, 16, 32] as const;
export const DET_NUM_ANCHORS = 2;
export const DET_SCORE_THRESHOLD = 0.5;
export const NMS_THRESHOLD = 0.4;

/** En dessous de cette taille (en pixels de l'image d'origine), le visage est ignoré. */
export const MIN_FACE_SIZE = 40;

/** Taille d'entrée du réseau de reconnaissance. */
export const REC_INPUT_SIZE = 112;

/**
 * Points de référence ArcFace pour un visage 112 × 112, dans l'ordre SCRFD :
 * œil gauche, œil droit, nez, coin gauche de la bouche, coin droit.
 */
export const ARCFACE_DST: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export interface DetectedFace {
  score: number;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  kps: Array<[number, number]>;
}

export interface FaceEmbedding {
  score: number;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  /** Vecteur 512 dims, normalisé L2. */
  embedding: number[];
}

/** Résout un système 4 × 4 par élimination de Gauss (retourne null si singulier). */
export function solve4x4(A: number[][], b: number[]): number[] | null {
  const n = 4;
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }

  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Estime la transformation de similarité x' = a·x − b·y + tx ;
 * y' = b·x + a·y + ty qui rapproche `src` de `dst` (moindres carrés).
 */
export function estimateSimilarity(
  src: Array<[number, number]>,
  dst: ReadonlyArray<readonly [number, number]>,
): { a: number; b: number; tx: number; ty: number } | null {
  const N = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
  const rhs = new Array<number>(4).fill(0);

  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    const rows = [
      [x, -y, 1, 0],
      [y, x, 0, 1],
    ];
    const targets = [X, Y];

    for (let r = 0; r < 2; r++) {
      for (let a = 0; a < 4; a++) {
        rhs[a] += rows[r][a] * targets[r];
        for (let b = 0; b < 4; b++) N[a][b] += rows[r][a] * rows[r][b];
      }
    }
  }

  const p = solve4x4(N, rhs);
  if (!p || p.some((value) => !Number.isFinite(value))) return null;

  const [a, b, tx, ty] = p;
  if (a * a + b * b < 1e-9) return null;
  return { a, b, tx, ty };
}

/** Échantillonnage bilinéaire dans une image RGB brute (3 canaux). */
function sampleBilinear(
  rgb: Buffer | Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Float32Array,
  offset: number,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const cx0 = Math.min(Math.max(x0, 0), width - 1);
  const cx1 = Math.min(Math.max(x0 + 1, 0), width - 1);
  const cy0 = Math.min(Math.max(y0, 0), height - 1);
  const cy1 = Math.min(Math.max(y0 + 1, 0), height - 1);

  for (let c = 0; c < 3; c++) {
    const p00 = rgb[(cy0 * width + cx0) * 3 + c];
    const p01 = rgb[(cy0 * width + cx1) * 3 + c];
    const p10 = rgb[(cy1 * width + cx0) * 3 + c];
    const p11 = rgb[(cy1 * width + cx1) * 3 + c];

    const top = p00 + (p01 - p00) * fx;
    const bottom = p10 + (p11 - p10) * fx;
    out[offset + c] = top + (bottom - top) * fy;
  }
}

/**
 * Recadre et aligne un visage en 112 × 112, au format attendu par ArcFace :
 * RGB planar (NCHW), normalisé (v − 127.5) / 127.5.
 */
export function alignFace(
  rgb: Buffer | Uint8Array,
  width: number,
  height: number,
  kps: Array<[number, number]>,
): Float32Array {
  const size = REC_INPUT_SIZE;
  const rgbOut = new Float32Array(size * size * 3);
  const transform = estimateSimilarity(kps, ARCFACE_DST);

  if (transform) {
    const { a, b, tx, ty } = transform;
    const denom = a * a + b * b;

    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        // Transformation inverse : (u, v) → coordonnées source.
        const dx = u - tx;
        const dy = v - ty;
        const sx = (a * dx + b * dy) / denom;
        const sy = (-b * dx + a * dy) / denom;
        sampleBilinear(rgb, width, height, sx, sy, rgbOut, (v * size + u) * 3);
      }
    }
  } else {
    // Repli si l'estimation échoue : carré centré sur les yeux et la bouche.
    const xs = kps.map((p) => p[0]);
    const ys = kps.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span =
      Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      ) * 2.2;
    const x0 = cx - span / 2;
    const y0 = cy - span / 2;

    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        sampleBilinear(
          rgb,
          width,
          height,
          x0 + (u * span) / size,
          y0 + (v * span) / size,
          rgbOut,
          (v * size + u) * 3,
        );
      }
    }
  }

  // RGB → CHW + normalisation.
  const chw = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      chw[c * plane + i] = (rgbOut[i * 3 + c] - 127.5) / 127.5;
    }
  }
  return chw;
}

/**
 * Décode les sorties SCRFD d'une stride.
 *
 * Les scores/boîtes/points sont exprimés dans le canevas de détection
 * (640 × 640) : on les ramène dans l'image d'origine via `detScale`.
 */
export function decodeStride(
  scores: Float32Array,
  bbox: Float32Array,
  kps: Float32Array,
  canvasSize: number,
  stride: number,
  detScale: number,
): DetectedFace[] {
  const gridHeight = Math.floor(canvasSize / stride);
  const gridWidth = Math.floor(canvasSize / stride);
  const faces: DetectedFace[] = [];

  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      for (let anchor = 0; anchor < DET_NUM_ANCHORS; anchor++) {
        const index = (y * gridWidth + x) * DET_NUM_ANCHORS + anchor;
        const score = scores[index];
        if (score < DET_SCORE_THRESHOLD) continue;

        const cx = x * stride;
        const cy = y * stride;
        const offset = index * 4;

        const x1 = (cx - bbox[offset] * stride) / detScale;
        const y1 = (cy - bbox[offset + 1] * stride) / detScale;
        const x2 = (cx + bbox[offset + 2] * stride) / detScale;
        const y2 = (cy + bbox[offset + 3] * stride) / detScale;

        const points: Array<[number, number]> = [];
        for (let i = 0; i < 5; i++) {
          points.push([
            (cx + kps[index * 10 + i * 2] * stride) / detScale,
            (cy + kps[index * 10 + i * 2 + 1] * stride) / detScale,
          ]);
        }

        faces.push({
          score,
          bbox: [x1, y1, x2, y2],
          width: x2 - x1,
          height: y2 - y1,
          kps: points,
        });
      }
    }
  }

  return faces;
}

/** Intersection over Union de deux boîtes. */
export function iou(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return intersection / (areaA + areaB - intersection + 1e-9);
}

/** Suppression des détections redondantes (par IoU). */
export function nonMaxSuppression(
  faces: DetectedFace[],
  threshold: number,
): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];

  for (const face of sorted) {
    if (kept.every((other) => iou(other.bbox, face.bbox) <= threshold)) {
      kept.push(face);
    }
  }

  return kept;
}

/** Garde les visages assez grands et suffisamment dans l'image. */
export function filterFaces(
  faces: DetectedFace[],
  width: number,
  height: number,
): DetectedFace[] {
  return faces.filter((face) => {
    if (face.width < MIN_FACE_SIZE || face.height < MIN_FACE_SIZE) return false;
    const [x1, y1, x2, y2] = face.bbox;
    return x1 > -20 && y1 > -20 && x2 < width + 20 && y2 < height + 20;
  });
}

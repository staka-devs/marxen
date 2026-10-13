import type { Translator } from "../../contracts/localization";
import { japaneseTranslator } from "../localization";
// Pure validators for fenced special blocks (Issue #6).
//
// These run inside the unified pipeline AND are reused by the client-side
// hydration (Leaflet / Three.js / Mermaid) so the pipeline verdict and the
// browser view never disagree. No heavy dependencies here: parsing stays
// synchronous and offline.

export interface BlockValidation {
  ok: boolean;
  /** Japanese reason shown when ok is false. */
  message?: string;
}

/**
 * Narrow an unknown value to a finite number for coordinate checks.
 *
 * Rejects NaN/Infinity so map bounds never compute from invalid input.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type GeoJsonGeometry =
  | { type: "Point"; coordinates: unknown }
  | { type: "LineString"; coordinates: unknown }
  | { type: "Polygon"; coordinates: unknown }
  | { type: "MultiPoint"; coordinates: unknown }
  | { type: "MultiLineString"; coordinates: unknown }
  | { type: "MultiPolygon"; coordinates: unknown }
  | { type: string; coordinates?: unknown; geometries?: unknown; features?: unknown; geometry?: unknown };

/**
 * Collect all finite numbers from nested coordinate arrays into `out`.
 *
 * Recurses through GeoJSON position nesting for bounds computation.
 */
function collectPositions(coordinates: unknown, out: number[]): void {
  if (isFiniteNumber(coordinates)) {
    out.push(coordinates);
    return;
  }
  if (Array.isArray(coordinates)) {
    for (const item of coordinates) collectPositions(item, out);
  }
}

/**
 * Validate a `[lng, lat]` position pair with finite numbers.
 *
 * Requires at least two finite entries; altitude and extras are ignored.
 */
function validatePositionPair(position: unknown): boolean {
  if (!Array.isArray(position) || position.length < 2) return false;
  return isFiniteNumber(position[0]) && isFiniteNumber(position[1]);
}

/**
 * Validate a GeoJSON geometry, returning a Japanese reason or null when ok.
 *
 * Covers Point/LineString/Polygon and multi variants; null when valid.
 */
function validateGeometry(geometry: GeoJsonGeometry | null, t: Translator = japaneseTranslator): string | null {
  if (!geometry || typeof geometry !== "object") return t("geometry がありません。");
  switch (geometry.type) {
    case "Point":
      return validatePositionPair(geometry.coordinates) ? null : t("Point の座標が不正です。");
    case "LineString":
    case "MultiPoint":
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return t("{{value0}} の座標が空です。", { value0: (geometry.type) });
      return (geometry.coordinates as unknown[]).every(validatePositionPair) ? null : t("{{value0}} の座標が不正です。", { value0: (geometry.type) });
    case "Polygon":
    case "MultiLineString": {
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return t("{{value0}} の座標が空です。", { value0: (geometry.type) });
      const rings = geometry.coordinates as unknown[];
      const bad = rings.some((ring) => !Array.isArray(ring) || (ring as unknown[]).length === 0 || !(ring as unknown[]).every(validatePositionPair));
      return bad ? t("{{value0}} の座標が不正です。", { value0: (geometry.type) }) : null;
    }
    case "MultiPolygon": {
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return t("MultiPolygon の座標が空です。");
      const polys = geometry.coordinates as unknown[][];
      const bad = polys.some(
        (poly) => !Array.isArray(poly) || poly.length === 0 || (poly as unknown[]).some((ring) => !Array.isArray(ring) || !(ring as unknown[]).every(validatePositionPair)),
      );
      return bad ? t("MultiPolygon の座標が不正です。") : null;
    }
    case "GeometryCollection":
      if (!Array.isArray(geometry.geometries)) return t("GeometryCollection の内容がありません。");
      for (const item of geometry.geometries as GeoJsonGeometry[]) {
        const error = validateGeometry(item, t);
        if (error) return error;
      }
      return null;
    default:
      return t("対応していない種別「{{value0}}」です。", { value0: (geometry.type) });
  }
}

export interface GeoJsonValidation extends BlockValidation {
  /** [minLon, minLat, maxLon, maxLat] for Leaflet fitBounds, or null. */
  bounds?: [number, number, number, number] | null;
  featureCount?: number;
}

/**
 * Validate a GeoJSON source, returning bounds and counts for map hydration.
 *
 * Parses JSON synchronously; failures carry Japanese messages for the error box.
 */
export function validateGeoJson(source: string, t: Translator = japaneseTranslator): GeoJsonValidation {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { ok: false, message: t("GeoJSON を JSON として読めません。Markdownを修正してください。") };
  }
  if (!data || typeof data !== "object") return { ok: false, message: t("GeoJSON がオブジェクトではありません。") };
  const doc = data as GeoJsonGeometry & { features?: unknown };
  if (doc.type === "FeatureCollection") {
    if (!Array.isArray(doc.features)) return { ok: false, message: t("FeatureCollection に features 配列がありません。") };
    for (const feature of doc.features as Array<{ geometry?: GeoJsonGeometry | null }>) {
      const error = validateGeometry(feature?.geometry ?? null, t);
      if (error) return { ok: false, message: t("地物データが不正です。{{value0}}", { value0: (error) }) };
    }
    return { ok: true, bounds: boundsOf(data), featureCount: doc.features.length };
  }
  if (doc.type === "Feature") {
    const error = validateGeometry((doc as { geometry?: GeoJsonGeometry | null }).geometry ?? null, t);
    return error ? { ok: false, message: t("地物データが不正です。{{value0}}", { value0: (error) }) } : { ok: true, bounds: boundsOf(data), featureCount: 1 };
  }
  const error = validateGeometry(doc, t);
  return error ? { ok: false, message: t("図形データが不正です。{{value0}}", { value0: (error) }) } : { ok: true, bounds: boundsOf(data), featureCount: 1 };
}

/** Compute lon/lat bounds from GeoJSON data, or null when empty. */ function boundsOf(data: unknown): [number, number, number, number] | null {
  const flat: number[] = [];
  collectPositions((data as { coordinates?: unknown; features?: unknown; geometries?: unknown }).coordinates ?? data, flat);
  const pairs: number[][] = [];
  if (data && typeof data === "object") {
    /** Collect lon/lat pairs from nested GeoJSON structures. */
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        if (node.length >= 2 && isFiniteNumber(node[0]) && isFiniteNumber(node[1])) pairs.push([node[0], node[1]]);
        else for (const item of node) visit(item);
      } else if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (Array.isArray(record.coordinates)) visit(record.coordinates);
        if (Array.isArray(record.features)) for (const feature of record.features as unknown[]) visit((feature as { geometry?: unknown }).geometry);
        if (Array.isArray(record.geometries)) for (const geometry of record.geometries as unknown[]) visit(geometry);
      }
    };
    visit(data);
  }
  if (pairs.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of pairs) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

export interface TopoJsonValidation extends BlockValidation {
  objectNames?: string[];
}

/** Validate TopoJSON with object names for Leaflet hydration. */ export function validateTopoJson(source: string, t: Translator = japaneseTranslator): TopoJsonValidation {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { ok: false, message: t("TopoJSON を JSON として読めません。Markdownを修正してください。") };
  }
  if (!data || typeof data !== "object") return { ok: false, message: t("TopoJSON がオブジェクトではありません。") };
  const doc = data as { type?: unknown; objects?: unknown; arcs?: unknown };
  if (doc.type !== "Topology") return { ok: false, message: t("type が Topology ではありません。") };
  if (!doc.objects || typeof doc.objects !== "object" || Array.isArray(doc.objects)) {
    return { ok: false, message: t("objects がありません。正しい TopoJSON を貼り付けてください。") };
  }
  const objectNames = Object.keys(doc.objects);
  if (objectNames.length === 0) return { ok: false, message: t("objects が空です。") };
  if (!Array.isArray(doc.arcs)) return { ok: false, message: t("arcs 配列がありません。") };
  return { ok: true, objectNames };
}

export interface StlValidation extends BlockValidation {
  facets: number;
}

const STL_VERTEX = /^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

/** Validate ASCII STL facet structure for 3D hydration. */ export function validateAsciiStl(source: string, t: Translator = japaneseTranslator): StlValidation {
  const lines = source.split("\n").map((line) => line.trimEnd());
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return { ok: false, facets: 0, message: t("STL が空です。") };
  const first = nonEmpty[0].trim();
  const last = nonEmpty[nonEmpty.length - 1].trim();
  if (!/^solid(\s+\S.*)?$/.test(first)) return { ok: false, facets: 0, message: t("solid で始まっていません。ASCII STL を貼り付けてください。") };
  if (!/^endsolid(\s+\S.*)?$/.test(last)) return { ok: false, facets: 0, message: t("endsolid がありません。途中で切れています。") };
  let openFacets = 0;
  let openLoops = 0;
  let facets = 0;
  for (const line of nonEmpty) {
    const text = line.trim();
    if (/^facet\s+normal\s+/i.test(text)) {
      openFacets += 1;
      continue;
    }
    if (/^endfacet/i.test(text)) {
      if (openFacets === 0 || openLoops !== 0) return { ok: false, facets, message: t("facet の対応が崩れています。") };
      openFacets -= 1;
      facets += 1;
      continue;
    }
    if (/^outer\s+loop/i.test(text)) {
      if (openFacets !== 1 || openLoops !== 0) return { ok: false, facets, message: t("outer loop の位置が不正です。") };
      openLoops += 1;
      continue;
    }
    if (/^endloop/i.test(text)) {
      if (openLoops !== 1) return { ok: false, facets, message: t("endloop の対応が崩れています。") };
      openLoops -= 1;
      continue;
    }
    const vertex = STL_VERTEX.exec(line);
    if (vertex) {
      if (openLoops !== 1) return { ok: false, facets, message: t("loop の外に vertex があります。") };
      const coords = [vertex[1], vertex[2], vertex[3]].map(Number);
      if (!coords.every((value) => Number.isFinite(value))) {
        return { ok: false, facets, message: t("頂点の座標が数値ではありません。「{{value0}}」を確認してください。", { value0: (text.trim()) }) };
      }
    }
  }
  if (openFacets !== 0 || openLoops !== 0) return { ok: false, facets, message: t("facet または loop が閉じていません。") };
  if (facets === 0) return { ok: false, facets, message: t("facet がありません。") };
  return { ok: true, facets };
}

/** Flat triangle soup for Three.js. Shared by the pipeline (count) and the client view (geometry). */
/** Parse ASCII STL triangles to positions for Three.js, or an error. */ export function parseAsciiStlTriangles(source: string, t: Translator = japaneseTranslator): { positions: Float32Array; facets: number } | { error: string } {
  const check = validateAsciiStl(source, t);
  if (!check.ok) return { error: check.message ?? t("STL が不正です。") };
  const positions: number[] = [];
  for (const line of source.split("\n")) {
    const vertex = STL_VERTEX.exec(line);
    if (vertex) positions.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]));
  }
  return { positions: new Float32Array(positions), facets: check.facets };
}

/** Check balanced delimiter pairs ignoring escaped occurrences. */ function balancedPairs(source: string, open: string, close: string): boolean {
  let depth = 0;
  for (const char of source) {
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Structural pre-check for Mermaid. The browser runs the real parser on hydrate. */
/** Validate Mermaid flowchart structure without rendering. */ export function validateMermaidStructure(source: string, t: Translator = japaneseTranslator): BlockValidation {
  if (source.trim() === "") return { ok: false, message: t("Mermaid の図の内容が空です。") };
  const pairs: Array<[string, string]> = [
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ];
  for (const [open, close] of pairs) {
    if (!balancedPairs(source, open, close)) {
      return { ok: false, message: t("Mermaid の「{{value0}}{{value1}}」の対応が崩れています。Markdownを確認してください。", { value0: (open), value1: (close) }) };
    }
  }
  return { ok: true };
}

/** Brace pre-check for TeX. MathJax renders valid input; invalid input keeps raw text. */
/** Validate TeX content for MathJax, rejecting executable links. */ export function validateMathContent(source: string, t: Translator = japaneseTranslator): BlockValidation {
  if (source.trim() === "") return { ok: false, message: t("数式が空です。") };
  if (!balancedPairs(source, "{", "}")) {
    return { ok: false, message: t("数式の { } の対応が崩れています。Markdownを確認してください。") };
  }
  return { ok: true };
}


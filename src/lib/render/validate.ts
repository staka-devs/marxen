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

function collectPositions(coordinates: unknown, out: number[]): void {
  if (isFiniteNumber(coordinates)) {
    out.push(coordinates);
    return;
  }
  if (Array.isArray(coordinates)) {
    for (const item of coordinates) collectPositions(item, out);
  }
}

function validatePositionPair(position: unknown): boolean {
  if (!Array.isArray(position) || position.length < 2) return false;
  return isFiniteNumber(position[0]) && isFiniteNumber(position[1]);
}

function validateGeometry(geometry: GeoJsonGeometry | null): string | null {
  if (!geometry || typeof geometry !== "object") return "geometry がありません。";
  switch (geometry.type) {
    case "Point":
      return validatePositionPair(geometry.coordinates) ? null : "Point の座標が不正です。";
    case "LineString":
    case "MultiPoint":
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return `${geometry.type} の座標が空です。`;
      return (geometry.coordinates as unknown[]).every(validatePositionPair) ? null : `${geometry.type} の座標が不正です。`;
    case "Polygon":
    case "MultiLineString": {
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return `${geometry.type} の座標が空です。`;
      const rings = geometry.coordinates as unknown[];
      const bad = rings.some((ring) => !Array.isArray(ring) || (ring as unknown[]).length === 0 || !(ring as unknown[]).every(validatePositionPair));
      return bad ? `${geometry.type} の座標が不正です。` : null;
    }
    case "MultiPolygon": {
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return "MultiPolygon の座標が空です。";
      const polys = geometry.coordinates as unknown[][];
      const bad = polys.some(
        (poly) => !Array.isArray(poly) || poly.length === 0 || (poly as unknown[]).some((ring) => !Array.isArray(ring) || !(ring as unknown[]).every(validatePositionPair)),
      );
      return bad ? "MultiPolygon の座標が不正です。" : null;
    }
    case "GeometryCollection":
      if (!Array.isArray(geometry.geometries)) return "GeometryCollection の内容がありません。";
      for (const item of geometry.geometries as GeoJsonGeometry[]) {
        const error = validateGeometry(item);
        if (error) return error;
      }
      return null;
    default:
      return `対応していない種別「${geometry.type}」です。`;
  }
}

export interface GeoJsonValidation extends BlockValidation {
  /** [minLon, minLat, maxLon, maxLat] for Leaflet fitBounds, or null. */
  bounds?: [number, number, number, number] | null;
  featureCount?: number;
}

export function validateGeoJson(source: string): GeoJsonValidation {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { ok: false, message: "GeoJSON を JSON として読めません。Markdownを修正してください。" };
  }
  if (!data || typeof data !== "object") return { ok: false, message: "GeoJSON がオブジェクトではありません。" };
  const doc = data as GeoJsonGeometry & { features?: unknown };
  if (doc.type === "FeatureCollection") {
    if (!Array.isArray(doc.features)) return { ok: false, message: "FeatureCollection に features 配列がありません。" };
    for (const feature of doc.features as Array<{ geometry?: GeoJsonGeometry | null }>) {
      const error = validateGeometry(feature?.geometry ?? null);
      if (error) return { ok: false, message: `地物データが不正です。${error}` };
    }
    return { ok: true, bounds: boundsOf(data), featureCount: doc.features.length };
  }
  if (doc.type === "Feature") {
    const error = validateGeometry((doc as { geometry?: GeoJsonGeometry | null }).geometry ?? null);
    return error ? { ok: false, message: `地物データが不正です。${error}` } : { ok: true, bounds: boundsOf(data), featureCount: 1 };
  }
  const error = validateGeometry(doc);
  return error ? { ok: false, message: `図形データが不正です。${error}` } : { ok: true, bounds: boundsOf(data), featureCount: 1 };
}

function boundsOf(data: unknown): [number, number, number, number] | null {
  const flat: number[] = [];
  collectPositions((data as { coordinates?: unknown; features?: unknown; geometries?: unknown }).coordinates ?? data, flat);
  const pairs: number[][] = [];
  if (data && typeof data === "object") {
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

export function validateTopoJson(source: string): TopoJsonValidation {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return { ok: false, message: "TopoJSON を JSON として読めません。Markdownを修正してください。" };
  }
  if (!data || typeof data !== "object") return { ok: false, message: "TopoJSON がオブジェクトではありません。" };
  const doc = data as { type?: unknown; objects?: unknown; arcs?: unknown };
  if (doc.type !== "Topology") return { ok: false, message: "type が Topology ではありません。" };
  if (!doc.objects || typeof doc.objects !== "object" || Array.isArray(doc.objects)) {
    return { ok: false, message: "objects がありません。正しい TopoJSON を貼り付けてください。" };
  }
  const objectNames = Object.keys(doc.objects);
  if (objectNames.length === 0) return { ok: false, message: "objects が空です。" };
  if (!Array.isArray(doc.arcs)) return { ok: false, message: "arcs 配列がありません。" };
  return { ok: true, objectNames };
}

export interface StlValidation extends BlockValidation {
  facets: number;
}

const STL_VERTEX = /^\s*vertex\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

export function validateAsciiStl(source: string): StlValidation {
  const lines = source.split("\n").map((line) => line.trimEnd());
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return { ok: false, facets: 0, message: "STL が空です。" };
  const first = nonEmpty[0].trim();
  const last = nonEmpty[nonEmpty.length - 1].trim();
  if (!/^solid(\s+\S.*)?$/.test(first)) return { ok: false, facets: 0, message: "solid で始まっていません。ASCII STL を貼り付けてください。" };
  if (!/^endsolid(\s+\S.*)?$/.test(last)) return { ok: false, facets: 0, message: "endsolid がありません。途中で切れています。" };
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
      if (openFacets === 0 || openLoops !== 0) return { ok: false, facets, message: "facet の対応が崩れています。" };
      openFacets -= 1;
      facets += 1;
      continue;
    }
    if (/^outer\s+loop/i.test(text)) {
      if (openFacets !== 1 || openLoops !== 0) return { ok: false, facets, message: "outer loop の位置が不正です。" };
      openLoops += 1;
      continue;
    }
    if (/^endloop/i.test(text)) {
      if (openLoops !== 1) return { ok: false, facets, message: "endloop の対応が崩れています。" };
      openLoops -= 1;
      continue;
    }
    const vertex = STL_VERTEX.exec(line);
    if (vertex) {
      if (openLoops !== 1) return { ok: false, facets, message: "loop の外に vertex があります。" };
      const coords = [vertex[1], vertex[2], vertex[3]].map(Number);
      if (!coords.every((value) => Number.isFinite(value))) {
        return { ok: false, facets, message: `頂点の座標が数値ではありません。「${text.trim()}」を確認してください。` };
      }
    }
  }
  if (openFacets !== 0 || openLoops !== 0) return { ok: false, facets, message: "facet または loop が閉じていません。" };
  if (facets === 0) return { ok: false, facets, message: "facet がありません。" };
  return { ok: true, facets };
}

/** Flat triangle soup for Three.js. Shared by the pipeline (count) and the client view (geometry). */
export function parseAsciiStlTriangles(source: string): { positions: Float32Array; facets: number } | { error: string } {
  const check = validateAsciiStl(source);
  if (!check.ok) return { error: check.message ?? "STL が不正です。" };
  const positions: number[] = [];
  for (const line of source.split("\n")) {
    const vertex = STL_VERTEX.exec(line);
    if (vertex) positions.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]));
  }
  return { positions: new Float32Array(positions), facets: check.facets };
}

function balancedPairs(source: string, open: string, close: string): boolean {
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
export function validateMermaidStructure(source: string): BlockValidation {
  if (source.trim() === "") return { ok: false, message: "Mermaid の図の内容が空です。" };
  const pairs: Array<[string, string]> = [
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ];
  for (const [open, close] of pairs) {
    if (!balancedPairs(source, open, close)) {
      return { ok: false, message: `Mermaid の「${open}${close}」の対応が崩れています。Markdownを確認してください。` };
    }
  }
  return { ok: true };
}

/** Brace pre-check for TeX. MathJax renders valid input; invalid input keeps raw text. */
export function validateMathContent(source: string): BlockValidation {
  if (source.trim() === "") return { ok: false, message: "数式が空です。" };
  if (!balancedPairs(source, "{", "}")) {
    return { ok: false, message: "数式の { } の対応が崩れています。Markdownを確認してください。" };
  }
  return { ok: true };
}

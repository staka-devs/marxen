// Client-side hydration for special blocks (Issue #6, lifecycles ADR-0062).
//
// The pipeline emits trusted placeholders with the raw source preserved as
// text. This module progressively enhances them in the browser using locally
// bundled libraries only (no CDN): Mermaid, Leaflet (+ topojson-client),
// Three.js. Every block is independent: a failure shows a Japanese message
// next to the raw source and never breaks the rest of the view.
//
// Lifecycles: every hydrate pass takes an AbortSignal. No DOM is written
// after abort (unmount, tab switch, superseded render), and
// `disposeMarkdownView` tears down Leaflet maps and Three.js renderers,
// geometries, and materials so repeated edits never leak listeners,
// WebGL contexts, or GPU memory.

import { parseAsciiStlTriangles, validateGeoJson, validateMermaidStructure, validateTopoJson } from "../../domain/render/validate";

let mermaidId = 0;

/** Tear-down callbacks for hydrated blocks (map / WebGL instance owners). */
const disposers = new WeakMap<HTMLElement, () => void>();

/** Read raw fenced source without trailing newline for validators. */ function rawSourceOf(block: Element): string {
  const code = block.querySelector("pre.marxen-raw > code.marxen-raw-text, details.marxen-source pre code");
  return code?.textContent?.replace(/\n$/, "") ?? "";
}

/** Show a Japanese error once per block unless aborted or detached. */ function markError(block: Element, signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) return;
  if (!block.isConnected) return;
  if (block.querySelector(":scope > .marxen-error")) return;
  const box = document.createElement("div");
  box.className = "marxen-error";
  box.setAttribute("role", "alert");
  box.textContent = message;
  block.insertBefore(box, block.querySelector(".marxen-mermaid-output, .marxen-map, .marxen-stl"));
}

/** Check output is connected and pass not aborted for safe writes. */ function checkAlive(output: Element | null, signal: AbortSignal | undefined): output is HTMLElement {
  if (signal?.aborted) return false;
  if (!output || !output.isConnected) return false;
  return true;
}

const SVG_EVENT_ATTR = /^on/i;
const SVG_EXEC_URL = /^\s*(javascript|vbscript|data)\s*:/i;

/**
 * Scrub a Mermaid SVG string before it touches the live DOM: drop scripts,
 * event-handler attributes, and executable link targets. Pure and
 * unit-testable; returns "" when the SVG does not parse.
 */
export function sanitizeSvg(svg: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch {
    return "";
  }
  if (doc.querySelector("parsererror")) return "";
  doc.querySelectorAll("script").forEach((el) => el.remove());
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode as Element | null;
  while (node) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (SVG_EVENT_ATTR.test(attr.name)) {
        node.removeAttribute(attr.name);
      } else if ((name === "href" || name === "xlink:href") && SVG_EXEC_URL.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
    node = walker.nextNode() as Element | null;
  }
  return new XMLSerializer().serializeToString(doc);
}

/** Hydrate Mermaid blocks with sanitized SVG, skipping invalid. */ async function hydrateMermaid(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  // Already-aborted passes return synchronously: never pay lazy imports.
  if (signal?.aborted) return;
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="mermaid"]:not([data-hydrated])')];
  if (blocks.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  signal?.throwIfAborted();
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
  for (const block of blocks) {
    if (signal?.aborted) return;
    if (block.dataset.invalid === "true") continue;
    const source = rawSourceOf(block);
    if (!validateMermaidStructure(source).ok) continue;
    const output = block.querySelector<HTMLElement>(".marxen-mermaid-output");
    if (!checkAlive(output, signal)) continue;
    try {
      mermaidId += 1;
      const { svg } = await mermaid.render(`marxen-mermaid-${mermaidId}`, source);
      if (!checkAlive(output, signal)) continue;
      const clean = sanitizeSvg(svg);
      if (clean === "") throw new Error("SVG として読めませんでした。");
      output.innerHTML = clean;
      block.dataset.hydrated = "true";
    } catch (cause) {
      if (signal?.aborted) return;
      markError(block, signal, `Mermaid を描画できません。${cause instanceof Error ? cause.message : "Markdownを確認してください。"}`);
    }
  }
}

/** Hydrate GeoJSON/TopoJSON maps offline with Leaflet vectors. */ async function hydrateGeoMaps(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  // Already-aborted passes return synchronously: never pay lazy imports.
  if (signal?.aborted) return;
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="geojson"]:not([data-hydrated]), [data-marxen-kind="topojson"]:not([data-hydrated])')];
  if (blocks.length === 0) return;
  const [{ default: L }, topojson] = await Promise.all([import("leaflet"), import("topojson-client")]);
  signal?.throwIfAborted();
  for (const block of blocks) {
    if (signal?.aborted) return;
    const kind = block.dataset.marxenKind;
    if (block.dataset.invalid === "true") continue;
    const container = block.querySelector<HTMLElement>(".marxen-map");
    if (!checkAlive(container, signal)) continue;
    try {
      const source = rawSourceOf(block);
      let geometry: unknown;
      if (kind === "topojson") {
        const parsed = JSON.parse(source) as { objects: Record<string, object> };
        const validation = validateTopoJson(source);
        if (!validation.ok) throw new Error(validation.message);
        const name = block.dataset.topoObject ?? validation.objectNames?.[0];
        const object = name ? parsed.objects[name] : undefined;
        if (!object) throw new Error("TopoJSON の objects が見つかりません。");
        geometry = topojson.feature(parsed, object);
      } else {
        const validation = validateGeoJson(source);
        if (!validation.ok) throw new Error(validation.message);
        geometry = JSON.parse(source);
      }
      // Offline vector view: no tile layer is added, so no external request
      // ever leaves the app. Vectors render on a plain local CRS canvas.
      const map = L.map(container).setView([35.6812, 139.7671], 5);
      disposers.set(block, () => {
        try {
          map.remove();
        } catch {
          // Already removed or half-built: teardown stays idempotent.
        }
        container.innerHTML = "";
      });
      const layer = L.geoJSON(geometry as never, {
        /** Render point features as small circle markers. */
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 6 }),
      });
      layer.addTo(map);
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      map.attributionControl.setPrefix(false);
      if (signal?.aborted || !block.isConnected) {
        disposeBlock(block);
        return;
      }
      block.dataset.hydrated = "true";
    } catch (cause) {
      if (signal?.aborted) return;
      disposeBlock(block);
      markError(block, signal, `地図を描画できません。${cause instanceof Error ? cause.message : "Markdownを確認してください。"}`);
    }
  }
}

/** Hydrate ASCII STL views with Three.js and dispose on teardown. */ async function hydrateStlViews(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  // Already-aborted passes return synchronously: never pay lazy imports.
  if (signal?.aborted) return;
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="stl"]:not([data-hydrated])')];
  if (blocks.length === 0) return;
  const THREE = await import("three");
  signal?.throwIfAborted();
  for (const block of blocks) {
    if (signal?.aborted) return;
    if (block.dataset.invalid === "true") continue;
    const container = block.querySelector<HTMLElement>(".marxen-stl");
    if (!checkAlive(container, signal)) continue;
    try {
      const parsed = parseAsciiStlTriangles(rawSourceOf(block));
      if ("error" in parsed) throw new Error(parsed.error);
      const width = Math.max(240, container.clientWidth || 480);
      const height = 280;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.MeshStandardMaterial({ color: 0x4d674b, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });
      disposers.set(block, () => {
        try {
          geometry.dispose();
          material.dispose();
          renderer.dispose();
          renderer.forceContextLoss();
        } catch {
          // Half-built GL state: teardown stays idempotent.
        }
        renderer.domElement.remove();
      });
      renderer.setSize(width, height);
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.setAttribute("aria-label", `STL 3D プレビュー（${parsed.facets} 面）`);
      container.appendChild(renderer.domElement);
      geometry.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const center = geometry.boundingSphere?.center ?? new THREE.Vector3();
      const radius = geometry.boundingSphere?.radius ?? 1;
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, material));
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const light = new THREE.DirectionalLight(0xffffff, 1.6);
      light.position.set(radius * 2, radius * 2, radius * 3);
      scene.add(light);
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, radius * 100);
      camera.position.set(center.x + radius * 2.2, center.y + radius * 1.6, center.z + radius * 2.2);
      camera.lookAt(center);
      renderer.render(scene, camera);
      if (signal?.aborted || !block.isConnected) {
        disposeBlock(block);
        return;
      }
      block.dataset.hydrated = "true";
    } catch (cause) {
      if (signal?.aborted) return;
      disposeBlock(block);
      markError(block, signal, `3D を描画できません。${cause instanceof Error ? cause.message : "Markdownを確認してください。"}`);
    }
  }
}

/** Tear down one block maps/GL and clear outputs idempotently. */ function disposeBlock(block: HTMLElement): void {
  const dispose = disposers.get(block);
  disposers.delete(block);
  try {
    dispose?.();
  } catch {
    // Teardown never throws: callers replace or discard the DOM anyway.
  }
  block.querySelectorAll(".marxen-map, .marxen-stl, .marxen-mermaid-output").forEach((el) => {
    el.innerHTML = "";
  });
  block.removeAttribute("data-hydrated");
}

/**
 * Tear down every hydrated block under `root`: Leaflet maps are removed and
 * Three.js renderers, geometries, and materials are disposed. Call before
 * replacing preview HTML and on unmount. Idempotent.
 */
export function disposeMarkdownView(root: HTMLElement): void {
  for (const block of root.querySelectorAll<HTMLElement>("[data-marxen-kind]")) disposeBlock(block);
}

/**
 * Enhance special blocks in place. Pass an AbortSignal to discard stale
 * passes: no DOM is written after abort. Resolves when all blocks settle.
 */
export async function hydrateMarkdownView(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  // Synchronous short-circuit: an already-aborted pass resolves without
  // touching lazy imports or the DOM.
  if (signal?.aborted) return;
  await Promise.allSettled([hydrateMermaid(root, signal), hydrateGeoMaps(root, signal), hydrateStlViews(root, signal)]);
}


// Client-side hydration for special blocks (Issue #6).
//
// The pipeline emits trusted placeholders with the raw source preserved as
// text. This module progressively enhances them in the browser using locally
// bundled libraries only (no CDN): Mermaid, Leaflet (+ topojson-client),
// Three.js. Every block is independent: a failure shows a Japanese message
// next to the raw source and never breaks the rest of the view.

import { parseAsciiStlTriangles, validateGeoJson, validateMermaidStructure, validateTopoJson } from "../../lib/render/validate";

let mermaidId = 0;

function rawSourceOf(block: Element): string {
  const code = block.querySelector("pre.marxen-raw > code.marxen-raw-text, details.marxen-source pre code");
  return code?.textContent?.replace(/\n$/, "") ?? "";
}

function markError(block: Element, message: string): void {
  if (block.querySelector(":scope > .marxen-error")) return;
  const box = document.createElement("div");
  box.className = "marxen-error";
  box.setAttribute("role", "alert");
  box.textContent = message;
  block.insertBefore(box, block.querySelector(".marxen-mermaid-output, .marxen-map, .marxen-stl"));
}

async function hydrateMermaid(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="mermaid"]:not([data-hydrated])')];
  if (blocks.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
  for (const block of blocks) {
    if (block.dataset.invalid === "true") continue;
    const source = rawSourceOf(block);
    if (!validateMermaidStructure(source).ok) continue;
    const output = block.querySelector<HTMLElement>(".marxen-mermaid-output");
    if (!output) continue;
    try {
      mermaidId += 1;
      const { svg } = await mermaid.render(`marxen-mermaid-${mermaidId}`, source);
      output.innerHTML = svg;
      block.dataset.hydrated = "true";
    } catch (cause) {
      markError(block, `Mermaid を描画できません。${cause instanceof Error ? cause.message : "原文を確認してください。"}`);
    }
  }
}

async function hydrateGeoMaps(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="geojson"]:not([data-hydrated]), [data-marxen-kind="topojson"]:not([data-hydrated])')];
  if (blocks.length === 0) return;
  const [{ default: L }, topojson] = await Promise.all([import("leaflet"), import("topojson-client")]);
  for (const block of blocks) {
    const kind = block.dataset.marxenKind;
    if (block.dataset.invalid === "true") continue;
    const container = block.querySelector<HTMLElement>(".marxen-map");
    if (!container) continue;
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
        geometry = topojson.feature(parsed as never, object as never);
      } else {
        const validation = validateGeoJson(source);
        if (!validation.ok) throw new Error(validation.message);
        geometry = JSON.parse(source);
      }
      // Offline vector view: no tile layer is added, so no external request
      // ever leaves the app. Vectors render on a plain local CRS canvas.
      const map = L.map(container).setView([35.6812, 139.7671], 5);
      const layer = L.geoJSON(geometry as never, {
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 6 }),
      });
      layer.addTo(map);
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      map.attributionControl.setPrefix(false);
      block.dataset.hydrated = "true";
    } catch (cause) {
      markError(block, `地図を描画できません。${cause instanceof Error ? cause.message : "原文を確認してください。"}`);
    }
  }
}

async function hydrateStlViews(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('[data-marxen-kind="stl"]:not([data-hydrated])')];
  if (blocks.length === 0) return;
  const THREE = await import("three");
  for (const block of blocks) {
    if (block.dataset.invalid === "true") continue;
    const container = block.querySelector<HTMLElement>(".marxen-stl");
    if (!container) continue;
    try {
      const parsed = parseAsciiStlTriangles(rawSourceOf(block));
      if ("error" in parsed) throw new Error(parsed.error);
      const width = Math.max(240, container.clientWidth || 480);
      const height = 280;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(width, height);
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.setAttribute("aria-label", `STL 3D プレビュー（${parsed.facets} 面）`);
      container.appendChild(renderer.domElement);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(parsed.positions, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      const center = geometry.boundingSphere?.center ?? new THREE.Vector3();
      const radius = geometry.boundingSphere?.radius ?? 1;
      const material = new THREE.MeshStandardMaterial({ color: 0x4d674b, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });
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
      block.dataset.hydrated = "true";
    } catch (cause) {
      markError(block, `3D を描画できません。${cause instanceof Error ? cause.message : "原文を確認してください。"}`);
    }
  }
}

/** Enhance special blocks in place. Resolves when all blocks settled. */
export async function hydrateMarkdownView(root: HTMLElement): Promise<void> {
  await Promise.allSettled([hydrateMermaid(root), hydrateGeoMaps(root), hydrateStlViews(root)]);
}

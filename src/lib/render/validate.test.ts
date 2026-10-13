import { describe, expect, it } from "vitest";
import {
  parseAsciiStlTriangles,
  validateAsciiStl,
  validateGeoJson,
  validateMathContent,
  validateMermaidStructure,
  validateTopoJson,
} from "./validate";

const TETRAHEDRON = [
  "solid tetrahedron",
  "  facet normal 0 0 -1",
  "    outer loop",
  "      vertex 0 0 0",
  "      vertex 0 1 0",
  "      vertex 1 0 0",
  "    endloop",
  "  endfacet",
  "endsolid tetrahedron",
].join("\n");

describe("special block validators", () => {
  it("accepts a Tokyo point FeatureCollection with bounds", () => {
    const result = validateGeoJson(
      '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"東京"},"geometry":{"type":"Point","coordinates":[139.7671,35.6812]}}]}',
    );
    expect(result.ok).toBe(true);
    expect(result.featureCount).toBe(1);
    expect(result.bounds?.[0]).toBeCloseTo(139.7671);
  });

  it("rejects broken GeoJSON without losing the reason", () => {
    expect(validateGeoJson('{"type":"FeatureCollection","features": [').ok).toBe(false);
    expect(validateGeoJson('{"type":"Point","coordinates":[139.7,"x"]}').ok).toBe(false);
    expect(validateGeoJson('{"type":"Nope","coordinates":[1,2]}').ok).toBe(false);
  });

  it("accepts TopoJSON with named objects and rejects null objects", () => {
    const valid = validateTopoJson(
      '{"type":"Topology","objects":{"region":{"type":"Polygon","arcs":[[0]]}},"arcs":[[[139,35],[140,35]]]}',
    );
    expect(valid.ok).toBe(true);
    expect(valid.objectNames).toEqual(["region"]);
    expect(validateTopoJson('{"type":"Topology","objects":null}').ok).toBe(false);
    expect(validateTopoJson("not json").ok).toBe(false);
  });

  it("counts STL facets and reports non-numeric vertices in Japanese", () => {
    const valid = validateAsciiStl(TETRAHEDRON);
    expect(valid.ok).toBe(true);
    expect(valid.facets).toBe(1);
    const badVertex = validateAsciiStl("solid bad\n  facet normal 0 0 1\n    outer loop\n      vertex invalid 0 0\n    endloop\n  endfacet\nendsolid bad");
    expect(badVertex.ok).toBe(false);
    expect(badVertex.message).toMatch(/数値/);
    expect(validateAsciiStl("solid incomplete\n  facet normal 0 0 1").ok).toBe(false);
    expect(validateAsciiStl("").ok).toBe(false);
  });

  it("parses STL triangles for the Three.js view", () => {
    const parsed = parseAsciiStlTriangles(TETRAHEDRON);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.facets).toBe(1);
      expect(parsed.positions.length).toBe(9);
    }
    expect("error" in parseAsciiStlTriangles("solid x")).toBe(true);
  });

  it("checks Mermaid bracket balance as a pipeline pre-check", () => {
    expect(validateMermaidStructure("flowchart LR\n    A --> B").ok).toBe(true);
    expect(validateMermaidStructure("flowchart LR\n    A --> [").ok).toBe(false);
    expect(validateMermaidStructure("").ok).toBe(false);
  });

  it("checks math brace balance as a MathJax pre-check", () => {
    expect(validateMathContent("E = mc^2").ok).toBe(true);
    expect(validateMathContent("\\frac{1}{").ok).toBe(false);
    expect(validateMathContent("").ok).toBe(false);
  });
});

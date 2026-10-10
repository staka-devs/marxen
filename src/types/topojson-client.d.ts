// Minimal typings for the untyped `topojson-client` runtime dependency.

declare module "topojson-client" {
  import type { Feature, FeatureCollection } from "geojson";
  export function feature(topology: object, o: object): Feature | FeatureCollection;
}

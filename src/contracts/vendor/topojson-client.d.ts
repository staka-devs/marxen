// Minimal typings for the untyped `topojson-client` runtime dependency.

declare module "topojson-client" {
  import type { Feature, FeatureCollection } from "geojson";
  /** Convert a TopoJSON object to GeoJSON features for Leaflet layers. */
  export function feature(topology: object, o: object): Feature | FeatureCollection;
}

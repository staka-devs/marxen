import type { DocumentLocation, RootScope } from "../contracts/contracts";

/** Compare Rust-issued root incarnations without consulting active UI state. */
export function sameRoot(left: RootScope | undefined, right: RootScope | undefined): boolean {
  return left?.rootId === right?.rootId && left?.generation === right?.generation;
}

/** Compare captured positions, including a rename away from and back to the same path. */
export function sameLocation(left: DocumentLocation | undefined, right: DocumentLocation | undefined): boolean {
  return sameRoot(left?.scope, right?.scope) && left?.path === right?.path && left?.position === right?.position;
}

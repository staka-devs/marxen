import { expect, it } from "vitest";
import fixture from "../../tests/fixtures/edit.json";
import type { DocumentEvent, EditRequest } from "./contracts";

it("uses UTF-16 code units in the shared wire fixture", () => {
  // The fixture is also deserialized and validated by the Rust integration test.
  const edit: EditRequest = { ...fixture, source: "gui" };
  expect("a😀日本語".slice(edit.edits[0].range.start, edit.edits[0].range.end)).toBe("😀");
  const event: DocumentEvent = { type: "mode", payload: { documentId: edit.documentId, revision: edit.baseRevision, mode: "visual_block" } };
  expect(JSON.parse(JSON.stringify(event))).toEqual(event);
});

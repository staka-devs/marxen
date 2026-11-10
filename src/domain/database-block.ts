// Embedded database view blocks (domain).
//
// A fenced `database` block names where its rows come from:
//
//   folder: tasks            (Markdown notes; frontmatter keys are columns)
//   sqlite: data/tasks.db    (a SQLite file inside the workspace)
//   table: tasks             (SQLite table, default `items`)
//
// Paths are relative to the document, or to the workspace root with `/`.

import type { DatabaseSource } from "../contracts/contracts";
import type { Translator } from "../contracts/localization";
import { japaneseTranslator } from "./localization";

/** Parsed block: a source to query, or a message for the error box. */
export type DatabaseBlock = { ok: true; source: DatabaseSource } | { ok: false; message: string };

/** Read `key: value` lines of a database block into a source. */
export function parseDatabaseBlock(text: string, t: Translator = japaneseTranslator): DatabaseBlock {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2]);
  }
  const folder = fields.get("folder");
  const sqlite = fields.get("sqlite");
  if (folder !== undefined && sqlite === undefined) return { ok: true, source: { kind: "folder", path: folder } };
  if (sqlite && folder === undefined) {
    if (!/\.(sqlite3?|db)$/i.test(sqlite)) return { ok: false, message: t("SQLite のファイル名は .sqlite、.sqlite3、.db で終えてください。") };
    return { ok: true, source: { kind: "sqlite", path: sqlite, table: fields.get("table") || "items" } };
  }
  return { ok: false, message: t("folder: か sqlite: のどちらか一つを書いてください。") };
}

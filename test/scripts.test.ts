// The page's plain scripts (static/*.js, loaded in order by index.html) share one global scope: a function declared
// at the top of two of them is silently replaced by the later one. That broke search on the revamp 2 preview
// (Find your meal's renderSearch in app.js replaced the search's in places.js), so every top-level name is unique.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const html = readFileSync(join(root, "static", "index.html"), "utf8");
// The edit mode's script (static/edit.js) is loaded by map.js for ?edit only, and the tutorial's (static/tutorial.js) by
// app.js tourLoad when it starts, into the same global scope.
const scripts = [...[...html.matchAll(/<script[^>]*\ssrc="\/([^"]+\.js)"/g)].map((m) => m[1]), "edit.js", "tutorial.js"];

/** The names declared at the start of a line (the scripts' top level): functions, classes, const, let and var. */
function topLevelNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/gm)) {
    names.push(m[1] ?? m[2] ?? m[3]);
  }
  return names;
}

describe("the page's scripts", () => {
  it("are found in index.html", () => {
    expect(scripts).toEqual(expect.arrayContaining(["lib.js", "picker.js", "sheet.js", "map.js", "places.js", "app.js"]));
  });

  it("finds top-level names, and only those", () => {
    expect(topLevelNames("function a() {}\nasync function b() {\n  function inner() {}\n}\nconst c = 1;\nlet d;\nclass E {}\n  const f = 2;")).toEqual(["a", "b", "c", "d", "E"]);
  });

  it("declare each top-level name once", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const file of scripts) {
      for (const name of topLevelNames(readFileSync(join(root, "static", file), "utf8"))) {
        const before = seen.get(name);
        if (before) clashes.push(`${name} (${before} and ${file})`);
        else seen.set(name, file);
      }
    }
    expect(clashes).toEqual([]);
  });
});

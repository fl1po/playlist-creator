import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The dashboard's logic lives in inline <script>s that tsc never sees. A syntax
// error there stops the whole page at "Checking authentication...", so at
// least make sure every one of them parses.

const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/web/public',
);

for (const file of fs
  .readdirSync(PUBLIC_DIR)
  .filter((f) => f.endsWith('.html'))) {
  test(`inline scripts in ${file} parse`, () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const scripts = [
      ...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g),
    ];
    for (const [, attrs, code] of scripts) {
      if (/type=["']module["']/.test(attrs)) continue; // vm.Script is classic-only
      assert.doesNotThrow(() => new vm.Script(code, { filename: file }));
    }
  });
}

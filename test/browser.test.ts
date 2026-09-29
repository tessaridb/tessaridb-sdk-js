import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { wireUrl } from '../src/wire/websocket.ts';

/**
 * What a browser can load.
 *
 * The browser entry must reach no `node:` module, by any path. That is a property
 * of the whole import graph rather than of one file, so it is checked by walking
 * the graph from the entry — one stray import three modules down is a bundle that
 * fails to build, or a page that fails to load, and neither shows up in Node.
 */
const here = dirname(fileURLToPath(import.meta.url));

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:import|export)[^'"]*?from\s+'([^']+)'/g,
  )) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

function reached(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    const specifiers = imports(file);
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

test('the browser entry reaches no node: module by any path', () => {
  const graph = reached(resolve(here, '../src/browser.ts'));
  assert.ok(
    graph.size > 10,
    `the walk found only ${graph.size} module(s), so it is not walking`,
  );
  const offending = [...graph].flatMap(([file, specifiers]) =>
    specifiers
      .filter((specifier) => specifier.startsWith('node:'))
      .map((specifier) => `${file} imports ${specifier}`),
  );
  assert.deepEqual(offending, []);
});

test('the Node entry does reach the TCP transport, so the walk can see one', () => {
  const graph = reached(resolve(here, '../src/index.ts'));
  const all = [...graph.values()].flat();
  assert.ok(
    all.includes('node:net'),
    'the walk missed the TCP transport the Node entry holds',
  );
});

test('the WebSocket address is the HTTP port and /wire', () => {
  assert.equal(wireUrl('127.0.0.1', 8000, false), 'ws://127.0.0.1:8000/wire');
  assert.equal(wireUrl('db.example', 443, true), 'wss://db.example:443/wire');
  assert.equal(wireUrl('::1', 8000, false), 'ws://[::1]:8000/wire');
  assert.equal(wireUrl('[::1]', 8000, false), 'ws://[::1]:8000/wire');
});

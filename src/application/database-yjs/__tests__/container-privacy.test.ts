import fs from 'fs';
import * as Y from 'yjs';
// Match the exact CJS logging sink imported by the pinned yjs/dist/yjs.cjs.
const logging = require('lib0/dist/logging.cjs');

// Intentionally fail on absent fixture: Rust must generate the pinned real bytes first.
const fixturePath = process.env.P3_PRIVACY_FIXTURE;
if (!fixturePath) throw new Error('P3_PRIVACY_FIXTURE must name the Rust raw-privacy.json fixture');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const bytes = (key: string): Uint8Array => Uint8Array.from(fixture[key]);

// Yjs 14.0.0-1 does not export decodeUpdate. Its supported logUpdate entrypoint
// calls LazyStructReader/readDeleteSet. Capture the typed objects at its output
// sink; never parse console text or mock any encoder/decoder/application path.
function requireShape(condition: unknown): asserts condition {
  if (!condition) throw new Error('Unexpected pinned decoder output shape');
}
function uint(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
const idPrototype = Object.getPrototypeOf(Y.createID(1, 0));
const deleteSetPrototype = Object.getPrototypeOf(Y.createDeleteSet());
const deleteRangePrototype = (() => {
  const doc = new Y.Doc();
  doc.getText('shape').insert(0, 'x');
  doc.getText('shape').delete(0, 1);
  const set = Y.createDeleteSetFromStructStore(doc.store);
  const prototype = Object.getPrototypeOf([...set.clients.values()][0][0]);
  doc.destroy();
  return prototype;
})();
function validateID(id: unknown) {
  requireShape(id && Object.getPrototypeOf(id) === idPrototype);
  const value = id as { client: unknown; clock: unknown };
  requireShape(uint(value.client) && uint(value.clock, 0xffffffff));
}
function validatePayload(value: unknown, parents = new Set<unknown>()) {
  if (value === null || ['undefined', 'string', 'boolean', 'number', 'bigint'].includes(typeof value)) return;
  requireShape(typeof value === 'object' && !parents.has(value));
  if (value instanceof Uint8Array) return;
  requireShape(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  parents.add(value);
  Object.values(value as object).forEach((child) => validatePayload(child, parents));
  parents.delete(value);
}
function validateContent(content: Y.Item['content'], length: number) {
  requireShape(content && typeof content === 'object');
  let keys: string[];
  if (content instanceof Y.ContentString) {
    keys = ['str'];
    requireShape(typeof content.str === 'string');
  } else if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON) {
    keys = ['arr'];
    requireShape(Array.isArray(content.arr));
    validatePayload(content.arr);
  } else if (content instanceof Y.ContentEmbed) {
    keys = ['embed'];
    validatePayload(content.embed);
  } else if (content instanceof Y.ContentFormat) {
    keys = ['key', 'value'];
    requireShape(typeof content.key === 'string');
    validatePayload(content.value);
  } else if (content instanceof Y.ContentBinary) {
    keys = ['content'];
    requireShape(content.content instanceof Uint8Array);
  } else if (content instanceof Y.ContentDeleted) {
    keys = ['len'];
    requireShape(uint(content.len, 0xffffffff) && content.len > 0);
  } else if (content instanceof Y.ContentType) {
    keys = ['type'];
    // This corpus uses maps and text. Fail closed on other shared types until
    // their metadata (e.g. XML tag names) is covered by the semantic inventory.
    requireShape(content.type instanceof Y.Map || content.type instanceof Y.Text);
  } else throw new Error('Unsupported pinned ItemContent class');
  requireShape(Object.keys(content).sort().join(',') === keys.sort().join(','));
  requireShape(content.getLength() === length);
}
function validateCapturedOutput(calls: unknown[][]) {
  requireShape(calls.length === 2 && calls.every((args) => args.length === 2));
  requireShape(calls[0][0] === 'Structs: ' && calls[1][0] === 'DeleteSet: ');
  const structs = calls[0][1] as Array<Y.Item | Y.GC | Y.Skip>;
  const ds = calls[1][1] as { clients: Map<number, Array<{ clock: number; len: number }>> };
  requireShape(Array.isArray(structs) && ds && Object.getPrototypeOf(ds) === deleteSetPrototype);
  requireShape(Object.keys(ds).join(',') === 'clients' && ds.clients instanceof Map);
  for (const [client, ranges] of ds.clients) {
    requireShape(uint(client) && Array.isArray(ranges) && ranges.length > 0);
    let lastEnd = -1;
    for (const range of ranges) {
      requireShape(range && Object.getPrototypeOf(range) === deleteRangePrototype);
      requireShape(Object.keys(range).sort().join(',') === 'clock,len');
      requireShape(uint(range.clock, 0xffffffff) && uint(range.len, 0xffffffff) && range.len > 0);
      requireShape(uint(range.clock + range.len, 0xffffffff) && range.clock >= lastEnd);
      lastEnd = range.clock + range.len;
    }
  }
  for (const struct of structs) {
    requireShape(struct instanceof Y.Item || struct instanceof Y.GC || struct instanceof Y.Skip);
    validateID(struct.id);
    requireShape(
      uint(struct.length, 0xffffffff) && struct.length > 0 && uint(struct.id.clock + struct.length, 0xffffffff)
    );
    if (struct instanceof Y.Item) {
      for (const id of [struct.origin, struct.rightOrigin]) if (id !== null) validateID(id);
      if (struct.parent !== null && typeof struct.parent !== 'string') validateID(struct.parent);
      requireShape(struct.parentSub === null || typeof struct.parentSub === 'string');
      validateContent(struct.content, struct.length);
    }
  }
  return { structs, ds };
}
function decodePinnedUpdate(update: Uint8Array) {
  const calls: unknown[][] = [];
  const sink = jest.spyOn(logging, 'print').mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  try {
    Y.logUpdate(update);
  } finally {
    sink.mockRestore();
  }
  return validateCapturedOutput(calls);
}

function raw(key: string) {
  const decoded = decodePinnedUpdate(bytes(key));
  const values: unknown[] = [];
  let stringFragments = '';
  const structural: unknown[] = [];
  decoded.structs.forEach((struct) => {
    structural.push(struct.id);
    if (struct instanceof Y.Item) {
      structural.push(struct.parent, struct.parentSub, struct.origin, struct.rightOrigin);
      // getContent alone drops format attributes: include each concrete content object's
      // own fields, independently of live-map visibility or whether it was deleted.
      const content = struct.content;
      if (content instanceof Y.ContentString) stringFragments += content.str;
      if (!(content instanceof Y.ContentDeleted) && !(content instanceof Y.ContentType)) {
        values.push(content);
      }
      if (typeof struct.parentSub === 'string' && fixture.markers.some((m: string) => struct.parentSub?.includes(m))) {
        values.push(struct.parentSub);
      }
    }
  });
  if (stringFragments) values.push(stringFragments);
  return { values, structural, decoded };
}
function leaked(key: string): string[] {
  const recoverable = JSON.stringify(raw(key).values);
  return fixture.markers.filter((marker: string) => recoverable.includes(marker));
}
function views(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('data').get('views') as Y.Map<Y.Map<unknown>>;
}
function assertSurvivor(doc: Y.Doc) {
  expect(views(doc).has(fixture.victim)).toBe(false);
  expect((views(doc).get(fixture.survivor)?.get('text') as Y.Text).toString()).toBe(fixture.survivor_text);
}

describe('raw_archive_gate cross-language committed update privacy', () => {
  test('leaky retained snapshot/update controls expose all rich and unknown payloads', () => {
    expect(leaked('pretrash')).toEqual(fixture.markers);
    expect(leaked('retained_receipt_snapshot')).toEqual(fixture.markers);
    expect(leaked('retained_redis_update')).toEqual(fixture.markers);
  });
  test.each(['sanitized', 'sanitized_diff', 'delete_only'])('%s has no recoverable archived item values', (key) => {
    expect(leaked(key)).toEqual([]);
    // Inventory every decoded content value, not just matching secret markers.
    expect(raw(key).values).toEqual(key === 'sanitized' ? raw('baseline').values : []);
  });
  test('delete-set-only update retains deletion clocks', () => {
    expect(raw('delete_only').decoded.structs).toHaveLength(0);
    expect(raw('delete_only').decoded.ds.clients.size).toBeGreaterThan(0);
  });
  test.each(['snapshot', 'diff', 'creation-first', 'creation-after'])(
    '%s preserves stale local CRDT edits and absence',
    (order) => {
      const doc = new Y.Doc();
      if (order === 'creation-first') Y.applyUpdate(doc, bytes('creation'));
      if (order === 'diff') {
        Y.applyUpdate(doc, bytes('baseline'));
        Y.applyUpdate(doc, bytes('sanitized_diff'));
      } else Y.applyUpdate(doc, bytes('sanitized'));
      if (order === 'creation-after') Y.applyUpdate(doc, bytes('creation'));
      Y.applyUpdate(doc, bytes('pending'));
      assertSurvivor(doc);
      // Original actor 101 clock lineage must remain present after merge.
      expect(Y.decodeStateVector(Y.encodeStateVector(doc)).get(101)).toBeGreaterThan(0);
    }
  );
  test('a real Yjs stale local edit survives the committed snapshot', () => {
    const stale = new Y.Doc();
    stale.clientID = 707;
    Y.applyUpdate(stale, bytes('pretrash'));
    const localText = views(stale).get(fixture.survivor)?.get('text') as Y.Text;
    localText.insert(localText.length, ' + pending local edit');
    Y.applyUpdate(stale, bytes('sanitized'));
    assertSurvivor(stale);
  });
});

// Negative controls validate the capture boundary only. The positive path always
// uses real pinned Yjs decoding; no fabricated object is used as fixture evidence.
describe('pinned decoder capture fails closed', () => {
  function captured() {
    const { structs, ds } = decodePinnedUpdate(bytes('sanitized'));
    return [
      ['Structs: ', structs],
      ['DeleteSet: ', ds],
    ] as unknown[][];
  }
  test('rejects missing, duplicate, reordered and extra decoder output', () => {
    const calls = captured();
    for (const bad of [calls.slice(0, 1), [...calls, calls[1]], [...calls].reverse(), [...calls, ['unexpected']]]) {
      expect(() => validateCapturedOutput(bad)).toThrow();
    }
  });
  test('rejects plain or malformed delete range and invalid client clocks', () => {
    for (const range of [{ clock: 0, len: 1 }, { clock: -1, len: 0 }, null]) {
      const calls = captured();
      (calls[1][1] as { clients: Map<number, unknown> }).clients.set(101, [range]);
      expect(() => validateCapturedOutput(calls)).toThrow();
    }
  });
  test('rejects bounded-range violations on real decoded range objects', () => {
    for (const corrupt of [
      (ds: ReturnType<typeof decodePinnedUpdate>['ds']) => {
        ds.clients.set(-1, [...ds.clients.values()][0]);
      },
      (ds: ReturnType<typeof decodePinnedUpdate>['ds']) => {
        [...ds.clients.values()][0][0].len = 0;
      },
      (ds: ReturnType<typeof decodePinnedUpdate>['ds']) => {
        [...ds.clients.values()][0][0].clock = Number.MAX_SAFE_INTEGER;
      },
    ]) {
      const { structs, ds } = decodePinnedUpdate(bytes('delete_only'));
      corrupt(ds);
      expect(() =>
        validateCapturedOutput([
          ['Structs: ', structs],
          ['DeleteSet: ', ds],
        ])
      ).toThrow();
    }
  });
  test('rejects malformed payload on a real decoded content class', () => {
    const { structs, ds } = decodePinnedUpdate(bytes('pretrash'));
    const item = structs.find((s) => s instanceof Y.Item && s.content instanceof Y.ContentString) as Y.Item;
    (item.content as Y.ContentString).str = 123 as unknown as string;
    expect(() =>
      validateCapturedOutput([
        ['Structs: ', structs],
        ['DeleteSet: ', ds],
      ])
    ).toThrow();
  });
  test('restores the real output sink when decoding truncated bytes throws', () => {
    const original = logging.print;
    expect(() => decodePinnedUpdate(Uint8Array.of(1))).toThrow();
    expect(logging.print).toBe(original);
  });
  test('rejects malformed item content and impossible IDs', () => {
    for (const corrupt of [
      (item: Y.Item) => {
        item.content = {} as typeof item.content;
      },
      (item: Y.Item) => {
        item.id.clock = -1;
      },
      (item: Y.Item) => {
        item.length = 0;
      },
    ]) {
      const calls = captured();
      const item = (calls[0][1] as Y.Item[]).find((s) => s instanceof Y.Item)!;
      corrupt(item);
      expect(() => validateCapturedOutput(calls)).toThrow();
    }
  });
});

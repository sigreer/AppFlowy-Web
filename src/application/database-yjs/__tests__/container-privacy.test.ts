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
function decodePinnedUpdate(update: Uint8Array) {
  let structs: Array<Y.Item | Y.GC | Y.Skip> | undefined;
  let ds: { clients: Map<number, unknown> } | undefined;
  const sink = jest.spyOn(logging, 'print').mockImplementation((...args: unknown[]) => {
    if (args[0] === 'Structs: ') structs = args[1] as typeof structs;
    else if (args[0] === 'DeleteSet: ') ds = args[1] as typeof ds;
    else throw new Error('Unexpected pinned decoder output');
  });
  try {
    Y.logUpdate(update);
  } finally {
    sink.mockRestore();
  }
  if (!Array.isArray(structs) || !ds || !(ds.clients instanceof Map))
    throw new Error('Pinned decoder did not yield structs and delete set');
  if (!structs.every((s) => s instanceof Y.Item || s instanceof Y.GC || s instanceof Y.Skip))
    throw new Error('Unexpected decoded struct type');
  return { structs, ds };
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

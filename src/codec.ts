/**
 * Checkpoint codec. Version 2 keeps binary content (images, documents, redacted reasoning) intact by
 * storing `Uint8Array` values as base64. Version 1 records contain no binary markers, so both decode.
 * Version 3 tool records store per-tool `appStateDelta` changes instead of a whole `appState` snapshot.
 * Version 4 escapes data that has the shape of a marker (`{"$bytes": …}` or `{"$esc": …}`) as `{"$esc": data}`,
 * so that model or tool output cannot decode as binary, and tool records name their tool use.
 */

const BYTES = "$bytes";
const ESCAPE = "$esc";

export const SCHEMA_VERSION = 4;

export type SchemaVersion = 1 | 2 | 3 | 4;

function isMarkerShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === BYTES || keys[0] === ESCAPE);
}

/** JSON-safe deep copy; `Uint8Array` values become `{ "$bytes": base64 }`. */
export function encode<T>(value: T): T {
  const wrappers = new WeakSet<object>();
  return JSON.parse(JSON.stringify(value, function (this: Record<string, unknown>, key, current: unknown) {
    const original = this[key];
    if (original instanceof Uint8Array) return { [BYTES]: Buffer.from(original).toString("base64") };
    // The wrapper's own `$esc` entry is the escaped value itself; escaping it again would never terminate.
    if (isMarkerShape(current) && !wrappers.has(this)) {
      const wrapper = { [ESCAPE]: current };
      wrappers.add(wrapper);
      return wrapper;
    }
    return current;
  })) as T;
}

/** Inverse of {@link encode} for a record of the given schema version. */
export function decode<T>(value: T, schemaVersion: SchemaVersion): T {
  const escapes = schemaVersion >= 4;
  // Top-down, so that an escaped object is recognized before its content is interpreted.
  const revive = (current: unknown): unknown => {
    if (typeof current !== "object" || current === null) return current;
    if (Array.isArray(current)) return current.map(revive);
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === BYTES && typeof record[BYTES] === "string") {
      return new Uint8Array(Buffer.from(record[BYTES], "base64"));
    }
    const escaped = escapes && keys.length === 1 && keys[0] === ESCAPE && typeof record[ESCAPE] === "object" && record[ESCAPE] !== null;
    const target = escaped ? record[ESCAPE] as Record<string, unknown> : record;
    // Own keys only: JSON.parse creates `__proto__` as an own data property, and assigning it keeps it one.
    for (const key of Object.keys(target)) target[key] = revive(target[key]);
    return target;
  };
  return revive(JSON.parse(JSON.stringify(value))) as T;
}

export function checked<T extends { schemaVersion: number }>(value: T): T {
  if (![1, 2, 3, 4].includes(value.schemaVersion)) {
    throw new Error(`Unsupported checkpoint schema: ${value.schemaVersion}`);
  }
  return value;
}

import { createHash } from "node:crypto";
import type { Serdes, SerdesContext } from "@aws/durable-execution-sdk-js";

/** Blob storage for checkpoint payloads that are too large to keep in the durable journal. */
export interface OffloadStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string>;
}

export type OffloadSerdesOptions = {
  store: OffloadStore;
  /** Payloads larger than this many UTF-8 bytes are stored in `store`. Default 64 KiB. */
  thresholdBytes?: number;
  /** Key prefix inside the store. */
  prefix?: string;
};

const POINTER = "$offload";
const DIGEST = "sha256";
const INLINE = "$inline";

type Pointer = { [POINTER]: string; [DIGEST]?: string };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{"$offload": key}` (before 0.3) or `{"$offload": key, "sha256": hex}`. */
function isPointer(value: unknown): value is Pointer {
  if (!isObject(value) || typeof value[POINTER] !== "string") return false;
  const keys = Object.keys(value);
  return keys.length === 1 || (keys.length === 2 && typeof value[DIGEST] === "string");
}

function isInline(value: unknown): value is { [INLINE]: unknown } {
  return isObject(value) && Object.keys(value).length === 1 && INLINE in value;
}

/**
 * JSON serdes that moves large checkpoint payloads to an {@link OffloadStore} and keeps only a pointer in the
 * journal. Keys are derived from the execution ARN and the operation ID, so a retry overwrites the same object.
 * Objects must outlive the execution's retention period; give the store a matching lifecycle rule.
 *
 * The journal is the trust anchor. A pointer is followed only if its key is the one this operation writes, and
 * the stored body must match the SHA-256 digest recorded next to it. An inline value that has the shape of a
 * pointer is wrapped as `{"$inline": value}`, so data can never be read back as a pointer.
 */
export function createOffloadSerdes({ store, thresholdBytes = 64 * 1024, prefix = "" }: OffloadSerdesOptions): Serdes<any> {
  const keyFor = (context: SerdesContext) =>
    `${prefix}${sha256(context.durableExecutionArn).slice(0, 32)}/${context.entityId}.json`;
  return {
    async serialize(value, context) {
      if (value === undefined) return undefined;
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) <= thresholdBytes) {
        const shape: unknown = body.startsWith("{") ? JSON.parse(body) : undefined;
        return isObject(shape) && (POINTER in shape || INLINE in shape) ? JSON.stringify({ [INLINE]: shape }) : body;
      }
      const key = keyFor(context);
      await store.put(key, body);
      return JSON.stringify({ [POINTER]: key, [DIGEST]: sha256(body) } satisfies Pointer);
    },
    async deserialize(data, context) {
      if (data === undefined) return undefined;
      const parsed: unknown = JSON.parse(data);
      if (isInline(parsed)) return parsed[INLINE];
      if (!isPointer(parsed)) return parsed;
      const key = parsed[POINTER];
      if (key !== keyFor(context)) {
        throw new Error(`Offload pointer ${JSON.stringify(key)} does not belong to operation ${context.entityId}`);
      }
      const body = await store.get(key);
      const digest = parsed[DIGEST];
      if (digest !== undefined && sha256(body) !== digest) {
        throw new Error(`Offloaded checkpoint ${key} does not match the digest recorded in the journal`);
      }
      return JSON.parse(body);
    },
  };
}

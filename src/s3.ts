import { GetObjectCommand, PutObjectCommand, type S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import type { OffloadStore } from "./offload.js";

export type S3OffloadStoreOptions = {
  client: S3Client;
  bucket: string;
  prefix?: string;
  /** Account ID that must own `bucket`. S3 rejects requests to a bucket owned by any other account. */
  expectedBucketOwner?: string;
  /** Server-side encryption for stored checkpoints, for example `aws:kms`. Default: the bucket's default encryption. */
  serverSideEncryption?: ServerSideEncryption;
  /** KMS key for `aws:kms` / `aws:kms:dsse`. Default: the AWS managed key `aws/s3`. */
  sseKmsKeyId?: string;
  /** Largest checkpoint body that is written or read, in bytes. Default 64 MiB. */
  maxBytes?: number;
};

/**
 * {@link OffloadStore} on Amazon S3. Requires `s3:PutObject` and `s3:GetObject` on `bucket/prefix*`, and with SSE-KMS
 * `kms:GenerateDataKey` and `kms:Decrypt` on the key.
 */
export function s3OffloadStore({
  client, bucket, prefix = "", expectedBucketOwner, serverSideEncryption, sseKmsKeyId, maxBytes = 64 * 1024 * 1024,
}: S3OffloadStoreOptions): OffloadStore {
  return {
    async put(key, body) {
      const size = Buffer.byteLength(body);
      if (size > maxBytes) throw new Error(`Checkpoint of ${size} bytes exceeds maxBytes (${maxBytes}): ${key}`);
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: prefix + key,
        Body: body,
        ContentType: "application/json",
        ExpectedBucketOwner: expectedBucketOwner,
        ServerSideEncryption: serverSideEncryption,
        SSEKMSKeyId: sseKmsKeyId,
      }));
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key, ExpectedBucketOwner: expectedBucketOwner }));
      if (!response.Body) throw new Error(`Empty offloaded checkpoint: s3://${bucket}/${prefix}${key}`);
      if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
        await response.Body.transformToWebStream().cancel();
        throw new Error(`Offloaded checkpoint s3://${bucket}/${prefix}${key} is larger than maxBytes (${maxBytes})`);
      }
      const body = await response.Body.transformToString();
      if (Buffer.byteLength(body) > maxBytes) {
        throw new Error(`Offloaded checkpoint s3://${bucket}/${prefix}${key} is larger than maxBytes (${maxBytes})`);
      }
      return body;
    },
  };
}

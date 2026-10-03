import type { S3Event, S3EventRecord } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

/**
 * Triggered by ObjectCreated events under the `raw/` prefix of the pipeline
 * bucket. Writes a small JSON manifest describing each new object to the
 * `manifests/` prefix of the *same* bucket — no read of the object's
 * contents is needed, so the function's IAM role only ever needs
 * `s3:PutObject` on `manifests/*`.
 *
 * The manifest is intentionally tiny and human-readable: it's the input
 * AWS Batch (Step 3) and Athena (Step 4) build on next.
 */
export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    await recordManifest(record);
  }
}

async function recordManifest(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  const sourceKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  const manifestKey = `manifests/${sourceKey.replace(/^raw\//, '')}.json`;

  const manifest = {
    bucket,
    sourceKey,
    sizeBytes: record.s3.object.size,
    eventName: record.eventName,
    eventTime: record.eventTime,
  };

  console.log('Recording manifest', { sourceKey, manifestKey });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    }),
  );
}

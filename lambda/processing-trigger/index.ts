import type { S3Event, S3EventRecord } from 'aws-lambda';
import { BatchClient, SubmitJobCommand } from '@aws-sdk/client-batch';

const batch = new BatchClient({});

const JOB_QUEUE_ARN = process.env.JOB_QUEUE_ARN!;
const JOB_DEFINITION_ARN = process.env.JOB_DEFINITION_ARN!;

/**
 * Triggered by ObjectCreated events under the `manifests/` prefix of the
 * pipeline bucket (written by `IngestFunction`, Step 2). Submits one AWS
 * Batch job per manifest to do the actual processing.
 *
 * This function is deliberately dumb: it never reads the manifest's
 * *contents* — only the S3 event's bucket/key, which it forwards to the job
 * as container environment overrides. The job itself (running in Batch,
 * see `batch/process/`) reads the manifest to find the raw object it
 * describes. Splitting it this way keeps this function's IAM footprint to
 * exactly one action (`batch:SubmitJob`) on exactly the one queue/definition
 * it's meant to use — no S3 read/write permissions at all.
 *
 * Packaged as a plain Zip function (`NodejsFunction`), not a container
 * image — unlike `IngestFunction` (Step 2), this handler has no unusual
 * packaging needs: one small dependency (`@aws-sdk/client-batch`), no
 * native modules. Zip is still the right default; Step 2's container image
 * was a deliberate exercise, not a new baseline.
 */
export async function handler(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    await submitProcessingJob(record);
  }
}

async function submitProcessingJob(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  const manifestKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  console.log('Submitting processing job', { bucket, manifestKey });

  // Accepted trade-off, not an oversight: `jobName` is a fixed string, not
  // derived from `manifestKey`, and nothing checks for an already-running
  // or already-completed job before calling SubmitJobCommand. S3's
  // at-least-once event delivery (or a retried Lambda invocation) can
  // therefore submit duplicate Batch jobs for the same manifest. This is
  // harmless today because the job's own writes to `processed/` converge
  // on the same output key regardless of how many times it runs — adding
  // deterministic naming or a dedup check would be solving a problem this
  // pipeline doesn't have yet.
  await batch.send(
    new SubmitJobCommand({
      jobName: 'process-manifest',
      jobQueue: JOB_QUEUE_ARN,
      jobDefinition: JOB_DEFINITION_ARN,
      containerOverrides: {
        environment: [
          { name: 'MANIFEST_BUCKET', value: bucket },
          { name: 'MANIFEST_KEY', value: manifestKey },
        ],
      },
    }),
  );
}

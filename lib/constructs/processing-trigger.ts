import { Construct } from 'constructs';
import * as path from 'node:path';
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib/core';
import { Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { EcsJobDefinition, JobQueue } from 'aws-cdk-lib/aws-batch';

export interface ProcessingTriggerProps {
  /** The queue to submit processing jobs to. */
  readonly jobQueue: JobQueue;

  /** The job definition to submit processing jobs against. */
  readonly jobDefinition: EcsJobDefinition;

  /**
   * What happens to the function's log group when the stack is destroyed.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Reacts to new manifests `IngestFunction` (Step 2) writes under
 * `manifests/`, and submits one `ProcessingJob` (AWS Batch) job per
 * manifest. See `lambda/processing-trigger/index.ts` for what it does.
 *
 * Packaged as a plain **Zip** function (`NodejsFunction`), in contrast with
 * `IngestFunction`'s container image — a deliberate contrast, not an
 * oversight: this handler has no unusual packaging needs (one small
 * dependency, no native modules), so Zip stays the right default. See
 * docs/02-lambda-ingest.md for when the other packaging earns its keep.
 */
export class ProcessingTrigger extends Construct {
  /** The underlying Lambda function, for wiring event sources. */
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: ProcessingTriggerProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;

    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.fn = new NodejsFunction(this, 'Resource', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'processing-trigger', 'index.ts'),
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      logGroup,
      environment: {
        JOB_QUEUE_ARN: props.jobQueue.jobQueueArn,
        JOB_DEFINITION_ARN: props.jobDefinition.jobDefinitionArn,
      },
    });

    // The only permission this function needs: submit against exactly the
    // one queue/definition it's wired to. It never touches S3 — see
    // lambda/processing-trigger/index.ts for why that split keeps this
    // role as narrow as IngestFunction's.
    props.jobDefinition.grantSubmitJob(this.fn, props.jobQueue);

    // Same X-Ray caveat as IngestFunction (Step 2): PutTraceSegments /
    // PutTelemetryRecords don't support resource-level scoping, so
    // Resource:* here is what AWS requires for tracing, not a grant this
    // construct chose.
    Validations.of(this.fn).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'X-Ray tracing (xray:PutTraceSegments / PutTelemetryRecords) does not support resource-level scoping; this Resource:* is the permission set AWS requires for tracing, not a broad grant this construct chose.',
    });
  }
}

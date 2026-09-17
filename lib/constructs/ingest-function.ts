import { Construct } from 'constructs';
import * as path from 'node:path';
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib/core';
import { Architecture, DockerImageCode, DockerImageFunction, Tracing } from 'aws-cdk-lib/aws-lambda';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';

export interface IngestFunctionProps {
  /**
   * What happens to the function's log group when the stack is destroyed.
   *
   * Defaults to `RETAIN`, matching production best practice. Pass `DESTROY`
   * explicitly for throwaway/demo stacks.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * The Lambda function that reacts to new objects landing under `raw/` in
 * the pipeline bucket. See `lambda/ingest/index.ts` for what it does.
 *
 * Packaged as a **container image** (`DockerImageFunction`) rather than a
 * Zip archive: `lambda/ingest/` is a self-contained mini-project with its
 * own `package.json` and `Dockerfile`, built and bundled independently of
 * the CDK app's own toolchain. `DockerImageCode.fromImageAsset()` runs
 * `docker build` on that directory during `cdk synth`/`deploy`, so a
 * Docker-compatible builder must be available wherever this stack is
 * synthesized — see docs/03-lambda-ingest.md for the operational
 * trade-offs of that choice, including cleanup (`cdk destroy` alone does
 * *not* remove the pushed image — see `cdk gc`).
 */
export class IngestFunction extends Construct {
  /** The underlying Lambda function, for wiring event sources and grants. */
  public readonly fn: DockerImageFunction;

  constructor(scope: Construct, id: string, props: IngestFunctionProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;

    // `logRetention` on `Function`/`DockerImageFunction` is deprecated (it
    // used to provision a custom-resource Lambda just to set retention).
    // Passing an explicit `LogGroup` via the `logGroup` prop is the
    // current, non-deprecated way to control retention and removal policy.
    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.fn = new DockerImageFunction(this, 'Resource', {
      code: DockerImageCode.fromImageAsset(
        path.join(__dirname, '..', '..', 'lambda', 'ingest'),
        // Without an explicit `platform`, Docker builds for the *host*
        // machine's architecture, not the Lambda function's — on an x86_64
        // build host (an Intel Mac, most CI runners) that silently produces
        // an amd64 image, which then fails at invoke time with "exec format
        // error" against this function's `Architecture.ARM_64`. Pinning the
        // build platform here keeps the image and the function architecture
        // in sync regardless of what machine runs `cdk synth`/`deploy`.
        { platform: Platform.LINUX_ARM64 },
      ),
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      tracing: Tracing.ACTIVE,
      logGroup,
    });

    // X-Ray's PutTraceSegments/PutTelemetryRecords actions don't support
    // resource-level scoping — AWS itself requires `Resource: "*"` for
    // tracing, so this is not a self-authored wildcard to tighten.
    Validations.of(this.fn).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'X-Ray tracing (xray:PutTraceSegments / PutTelemetryRecords) does not support resource-level scoping; this Resource:* is the permission set AWS requires for tracing, not a broad grant this construct chose.',
    });
  }
}

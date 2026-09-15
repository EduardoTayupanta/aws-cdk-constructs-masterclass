import { Construct } from 'constructs';
import * as path from 'node:path';
import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib/core';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
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
 * Built with `NodejsFunction` (an L2 in `aws-lambda-nodejs`) rather than
 * the plain `Function` L2: it bundles and type-checks the TypeScript
 * handler with esbuild at synth time, so there's no separate build step to
 * remember before `cdk deploy` — another example of an L2 absorbing
 * boilerplate a caller would otherwise have to own.
 */
export class IngestFunction extends Construct {
  /** The underlying Lambda function, for wiring event sources and grants. */
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: IngestFunctionProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;

    // `logRetention` on `Function`/`NodejsFunction` is deprecated (it used
    // to provision a custom-resource Lambda just to set retention). Passing
    // an explicit `LogGroup` via the `logGroup` prop is the current,
    // non-deprecated way to control retention and removal policy.
    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    this.fn = new NodejsFunction(this, 'Resource', {
      entry: path.join(__dirname, '..', '..', 'lambda', 'ingest', 'index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      tracing: Tracing.ACTIVE,
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
      },
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

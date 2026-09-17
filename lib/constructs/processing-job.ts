import { Construct } from 'constructs';
import * as path from 'node:path';
import { Duration, RemovalPolicy, Size, Validations } from 'aws-cdk-lib/core';
import {
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  IVpc,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { ContainerImage, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  EcsFargateContainerDefinition,
  EcsJobDefinition,
  FargateComputeEnvironment,
  JobQueue,
} from 'aws-cdk-lib/aws-batch';

export interface ProcessingJobProps {
  /**
   * What happens to the job's log group when the stack is destroyed.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * The AWS Batch infrastructure that processes one raw object per manifest
 * `IngestFunction` (Step 2) writes: a VPC, a Fargate compute environment, a
 * job queue, and the job definition itself. See `batch/process/` for what
 * the job actually does, and `ProcessingTrigger` for what submits it.
 *
 * Runs on **Fargate**, not EC2-backed compute — there's no fleet of
 * instances to size or patch for a job this small and infrequent.
 *
 * The compute environment's tasks live in **isolated subnets with no NAT
 * Gateway**. Everything a task needs — pulling its own image, reading and
 * writing S3, shipping logs — goes over VPC endpoints instead of the public
 * internet: a Gateway endpoint for S3 (free) and Interface endpoints for
 * ECR (API + Docker registry) and CloudWatch Logs. See
 * docs/04-batch-processing.md for the cost trade-off that choice implies
 * versus a NAT Gateway or public subnets.
 */
export class ProcessingJob extends Construct {
  /** The VPC the compute environment's tasks run in. */
  public readonly vpc: IVpc;

  /** The queue `ProcessingTrigger` submits jobs to. */
  public readonly jobQueue: JobQueue;

  /** The job definition `ProcessingTrigger` submits jobs against. */
  public readonly jobDefinition: EcsJobDefinition;

  /**
   * The role the running container assumes — grant it access to whatever
   * S3 prefixes the job needs to read or write.
   */
  public readonly jobRole: Role;

  constructor(scope: Construct, id: string, props: ProcessingJobProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;

    // A single AZ: this VPC exists solely to run one Batch job at a time,
    // not a highly-available service — a second AZ would buy no resilience
    // for a job that isn't running redundantly across it, while doubling
    // the hourly cost of every interface endpoint below (one ENI per AZ
    // each).
    this.vpc = new Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Two security groups, not one shared: `computeSecurityGroup` is what
    // the tasks themselves get attached to, `endpointsSecurityGroup` is
    // what the interface endpoints' network interfaces get attached to.
    // Neither allows all outbound/inbound traffic — the single rule below
    // opens exactly the path this job needs (tasks -> endpoints on 443)
    // and nothing else in either direction.
    const endpointsSecurityGroup = new SecurityGroup(this, 'EndpointsSecurityGroup', {
      vpc: this.vpc,
      description: 'Attached to the VPC interface endpoints (ECR, CloudWatch Logs)',
      allowAllOutbound: false,
    });

    const computeSecurityGroup = new SecurityGroup(this, 'ComputeSecurityGroup', {
      vpc: this.vpc,
      description: 'Attached to the Fargate tasks running the processing job',
      allowAllOutbound: false,
    });

    computeSecurityGroup.connections.allowTo(
      endpointsSecurityGroup,
      Port.HTTPS,
      'Processing job tasks -> VPC interface endpoints',
    );

    // Free, and the only way an isolated-subnet task can reach S3 without
    // a NAT Gateway: routed via the VPC's route table, not a network
    // interface, so it needs no security group of its own.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
    });

    // Interface endpoints (billed hourly, unlike the S3 gateway endpoint
    // above) for the two things a NAT-less Fargate task otherwise can't
    // reach: pulling its own image from ECR, and shipping logs to
    // CloudWatch via the `awslogs` driver.
    for (const [endpointId, service] of [
      ['EcrApiEndpoint', InterfaceVpcEndpointAwsService.ECR],
      ['EcrDockerEndpoint', InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['LogsEndpoint', InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ] as const) {
      this.vpc.addInterfaceEndpoint(endpointId, {
        service,
        subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
        securityGroups: [endpointsSecurityGroup],
        // Interface endpoints default to `open: true`, which allows the
        // *entire VPC CIDR* to reach them on 443 regardless of the
        // security groups passed above — the explicit SG-to-SG rule from
        // `computeSecurityGroup` already covers exactly what this needs.
        open: false,
      });
    }

    const computeEnvironment = new FargateComputeEnvironment(this, 'ComputeEnvironment', {
      vpc: this.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [computeSecurityGroup],
      // One job at a time is the norm for this pipeline; 4 vCPUs of
      // headroom is enough for a handful to overlap without needing to
      // reason about Batch's scheduler queuing behavior for this demo.
      maxvCpus: 4,
    });

    this.jobQueue = new JobQueue(this, 'JobQueue', {
      computeEnvironments: [{ computeEnvironment, order: 1 }],
      priority: 1,
    });

    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy,
    });

    // Unlike `executionRole` (which `EcsFargateContainerDefinition` creates
    // for us — it only needs to pull the image and write logs), there's no
    // default `jobRole`: it's what the running container's own AWS SDK
    // calls authenticate as, so its permissions are this construct's
    // caller's responsibility to grant (see `DataPipelineStack`, which
    // grants it read on raw/manifests and write on processed/).
    this.jobRole = new Role(this, 'JobRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const container = new EcsFargateContainerDefinition(this, 'Container', {
      image: ContainerImage.fromAsset(path.join(__dirname, '..', '..', 'batch', 'process')),
      cpu: 0.25,
      memory: Size.mebibytes(512),
      jobRole: this.jobRole,
      logging: LogDrivers.awsLogs({ logGroup, streamPrefix: 'processing-job' }),
    });

    this.jobDefinition = new EcsJobDefinition(this, 'JobDefinition', {
      container,
      timeout: Duration.minutes(5),
      retryAttempts: 2,
    });

    // `ecr:GetAuthorizationToken` — needed by the auto-created execution
    // role to authenticate to ECR before pulling the image — is, like
    // X-Ray's tracing actions (see IngestFunction, Step 2), an AWS API
    // with no resource-level scoping at all: Resource:* is the only form
    // this permission can take, not a wildcard this construct chose.
    Validations.of(container).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason:
        'ecr:GetAuthorizationToken (needed to authenticate to ECR before pulling this job\'s image) does not support resource-level scoping; AWS requires Resource:* for it.',
    });

    // This VPC exists solely to run this one Batch job's ephemeral Fargate
    // tasks — it has no other workloads, no inbound exposure, and no
    // internet route (isolated subnets, no NAT/IGW). Flow logs would add
    // an ongoing CloudWatch Logs cost with no corresponding benefit for
    // this walkthrough; a real multi-tenant VPC should still turn them on.
    Validations.of(this.vpc).acknowledge({
      id: 'AwsSolutions-VPC7',
      reason:
        'Single-purpose demo VPC for this construct\'s own ephemeral Batch/Fargate tasks only — isolated subnets, no NAT/IGW, no other workloads. Flow logs would add ongoing cost with no compensating benefit for this walkthrough.',
    });
  }
}

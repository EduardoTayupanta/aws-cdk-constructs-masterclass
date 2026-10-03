#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib/core';
import { Validations } from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataPipelineStack } from '../lib/data-pipeline-stack';

const app = new cdk.App();

new DataPipelineStack(app, 'DataPipelineStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

// Registered at the App level, via CDK's native Validations/policy-plugin
// mechanism, so every stack added in later steps of the masterclass
// (Lambda, Batch, Athena) is checked against the AWS Solutions rule pack
// automatically during synthesis — no extra wiring per stack.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

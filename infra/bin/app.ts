#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WorkdayAiPlatformStack } from '../lib/stack';

const app = new cdk.App();

new WorkdayAiPlatformStack(app, 'WorkdayAiPlatformStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // us-east-1 has the broadest Bedrock model availability including
    // Claude Sonnet 4.6 and Titan Embeddings v2.
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Lumina — AI-powered configuration intelligence for enterprise systems',
});

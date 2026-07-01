import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2_authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

const GENERATION_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM = 1024;

export class WorkdayAiPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: 'public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ['http://localhost:5173', 'http://localhost:3000', 'https://main.d2jd92e8asbd1j.amplifyapp.com'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
        },
      ],
    });

    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'platformadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'DB access',
    });

    const dbCluster = new rds.DatabaseCluster(this, 'Db', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'platform',
      writer: rds.ClusterInstance.serverlessV2('writer', {
        scaleWithWriter: true,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 1,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const vectorTable = new dynamodb.Table(this, 'VectorTable', {
      tableName: 'workday-ai-vectors',
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'chunk_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    // Platform configuration table (for admin)
    const configTable = new dynamodb.Table(this, 'ConfigTable', {
      tableName: 'workday-ai-config',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: false,
    });

    const auditTable = new dynamodb.Table(this, 'AuditTable', {
      tableName: 'workday-ai-audit',
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_ts', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    auditTable.addGlobalSecondaryIndex({
      indexName: 'action-index',
      partitionKey: { name: 'action', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_ts', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    vectorTable.addGlobalSecondaryIndex({
      indexName: 'doc_id-index',
      partitionKey: { name: 'doc_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: true }),
        role: new cognito.StringAttribute({ mutable: true }),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userSrp: true, userPassword: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(8),
      idTokenValidity: cdk.Duration.hours(8),
    });

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });



    // Cost Explorer — always us-east-1, resource-level permissions not supported
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ce:GetCostAndUsage'],
        resources: ['*'],
      })
    );

    // Grant Bedrock permissions for all Claude Sonnet and Titan models
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${EMBEDDING_MODEL_ID}`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      })
    );
    // Grant Cognito permissions for admin user management
// Grant Cognito permissions for admin user management
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminResetUserPassword',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminSetUserMFAPreference',
          'cognito-idp:ListUsers',
        ],
        resources: [userPool.userPoolArn],
      })
    );
    vectorTable.grantReadWriteData(lambdaRole);
    configTable.grantReadWriteData(lambdaRole);
    auditTable.grantReadWriteData(lambdaRole);
    docsBucket.grantReadWrite(lambdaRole);
    dbCluster.grantDataApiAccess(lambdaRole);
    dbSecret.grantRead(lambdaRole);

    const commonEnv: Record<string, string> = {
      DOCS_BUCKET: docsBucket.bucketName,
      DB_CLUSTER_ARN: dbCluster.clusterArn,
      DB_SECRET_ARN: dbSecret.secretArn,
      DB_NAME: 'platform',
      VECTOR_TABLE_NAME: vectorTable.tableName,
      GENERATION_MODEL_ID,
      EMBEDDING_MODEL_ID,
      EMBEDDING_DIM: String(EMBEDDING_DIM),
      POWERTOOLS_SERVICE_NAME: 'workday-ai-platform',
      LOG_LEVEL: 'INFO',
      CONFIG_TABLE_NAME: configTable.tableName,
      AUDIT_TABLE_NAME: auditTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      DOCS_BUCKET_NAME: docsBucket.bucketName,
    };

    const lambdasRoot = path.join(__dirname, '..', '..', 'lambdas');

    const makeFn = (name: string, handlerPath: string, timeoutSec = 30, handlerFn = 'handler.handler') =>
      new lambda.Function(this, name, {
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        code: lambda.Code.fromAsset(lambdasRoot, {
          bundling: {
            image: lambda.Runtime.PYTHON_3_12.bundlingImage,
            platform: 'linux/arm64',
            command: [
              'bash', '-c',
              [
                `pip install -r ${handlerPath}/requirements.txt -t /asset-output`,
                `cp -au ${handlerPath}/. /asset-output/`,
                `cp -au common /asset-output/common`,
                `mkdir -p /asset-output/config && cp -au config/. /asset-output/config/`,
              ].join(' && '),
            ],
          },
        }),
        handler: handlerFn,
        role: lambdaRole,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        timeout: cdk.Duration.seconds(timeoutSec),
        memorySize: 1024,
        environment: commonEnv,
        logRetention: logs.RetentionDays.ONE_WEEK,
      });

    const uploadUrlFn = makeFn('UploadUrlFn', 'upload_url', 15);
    const ingestFn = makeFn('IngestFn', 'ingest', 120);
    const analyzeFn = makeFn('AnalyzeFn', 'analyze', 90);
    const chatFn = makeFn('ChatFn', 'chat', 60);
    // Admin functions
    const adminCreateTenantFn = makeFn('AdminCreateTenantFn', 'admin_create_tenant', 30);
    const adminCreateUserFn = makeFn('AdminCreateUserFn', 'admin_create_user', 30);
    const adminListTenantsFn = makeFn('AdminListTenantsFn', 'admin_list_tenants', 30);
    // Document management functions
    const documentsListFn = makeFn('DocumentsListFn', 'documents_list', 30);
    const documentsDownloadUrlFn = makeFn('DocumentsDownloadUrlFn', 'documents_download_url', 15);
    // Folder structure functions
    const adminGetTemplatesFn = makeFn('AdminGetTemplatesFn', 'admin_get_templates', 15);
    const tenantFolderStructureFn = makeFn('TenantFolderStructureFn', 'tenant_folder_structure', 15);
    const documentsDeleteFn = makeFn('DocumentsDeleteFn', 'documents_delete', 30);
    const documentsPublishFn = makeFn('DocumentsPublishFn', 'documents_publish', 30);
    // Security & project admin functions
    const consultantMyClientsFn = makeFn('ConsultantMyClientsFn', 'consultant_my_clients', 15);
    const adminAssignConsultantFn = makeFn('AdminAssignConsultantFn', 'admin_assign_consultant', 15);
    const adminListUsersFn = makeFn('AdminListUsersFn', 'admin_list_users', 30);
    const adminResetPasswordFn = makeFn('AdminResetPasswordFn', 'admin_reset_password', 15);
    const adminAuditLogFn = makeFn('AdminAuditLogFn', 'admin_audit_log', 30);
    const adminCostSummaryFn = makeFn('AdminCostSummaryFn', 'admin_cost_summary', 30);
    const adminArchiveClientFn = makeFn('AdminArchiveClientFn', 'admin_archive_client', 15);
    const adminManageUserFn = makeFn('AdminManageUserFn', 'admin_manage_user', 15);
    const sowValidateFn = makeFn('SowValidateFn', 'sow_validate', 90);
    const adminUpdateUserFn = makeFn('AdminUpdateUserFn', 'admin_update_user', 15);
    const mfaResetRequestFn = makeFn('MfaResetRequestFn', 'mfa_reset_request', 15);
    const changeImpactFn = makeFn('ChangeImpactFn', 'change_impact', 60);
    const generateTestsFn = makeFn('GenerateTestsFn', 'generate_tests', 29);
    const generateTestsWorkerFn = makeFn('GenerateTestsWorkerFn', 'generate_tests', 120, 'handler.worker_handler');
    generateTestsWorkerFn.grantInvoke(lambdaRole);
    generateTestsFn.addEnvironment('GENERATE_TESTS_WORKER_FUNCTION_ARN', generateTestsWorkerFn.functionArn);
    const testScriptsStatusFn = makeFn('TestScriptsStatusFn', 'test_scripts_status', 15);
    const statusReportFn = makeFn('StatusReportFn', 'status_report', 120);

    // Bootstrap — runs on every deploy, idempotent
    const bootstrapFn = makeFn('BootstrapFn', 'bootstrap', 120);
    const bootstrapProvider = new cr.Provider(this, 'BootstrapProvider', {
      onEventHandler: bootstrapFn,
    });
    new cdk.CustomResource(this, 'Bootstrap', {
      serviceToken: bootstrapProvider.serviceToken,
      // Changing this string forces re-execution on next deploy
      properties: { Version: '4' },
    });

    dbSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Lambda access'
    );

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Client-Tenant'],
      },
    });

    const authorizer = new apigwv2_authorizers.HttpJwtAuthorizer(
      'JwtAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      }
    );
    new cdk.CfnOutput(this, 'ConfigTableName', { value: configTable.tableName });
    httpApi.addRoutes({
      path: '/upload-url',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('UploadUrlInt', uploadUrlFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/ingest',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('IngestInt', ingestFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/analyze',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AnalyzeInt', analyzeFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('ChatInt', chatFn),
      authorizer,
    });
    // Admin routes
    httpApi.addRoutes({
      path: '/admin/create-tenant',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminCreateTenantInt', adminCreateTenantFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/create-user',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminCreateUserInt', adminCreateUserFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/list-tenants',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminListTenantsInt', adminListTenantsFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/get-templates',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminGetTemplatesInt', adminGetTemplatesFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/tenant/folder-structure',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('TenantFolderStructureInt', tenantFolderStructureFn),
      authorizer,
    });
        // Document routes
    httpApi.addRoutes({
      path: '/documents/list',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('DocumentsListInt', documentsListFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/documents/download-url',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('DocumentsDownloadUrlInt', documentsDownloadUrlFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/documents/delete',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('DocumentsDeleteInt', documentsDeleteFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/documents/publish',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('DocumentsPublishInt', documentsPublishFn),
      authorizer,
    });
    // Consultant client-switcher
    httpApi.addRoutes({
      path: '/consultant/my-clients',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('ConsultantMyClientsInt', consultantMyClientsFn),
      authorizer,
    });
    // Project admin routes
    httpApi.addRoutes({
      path: '/admin/assign-consultant',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminAssignConsultantInt', adminAssignConsultantFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/assignments',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminListAssignmentsInt', adminAssignConsultantFn),
      authorizer,
    });
    // Security admin routes
    httpApi.addRoutes({
      path: '/admin/list-users',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminListUsersInt', adminListUsersFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/reset-password',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminResetPasswordInt', adminResetPasswordFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/audit-log',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminAuditLogInt', adminAuditLogFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/costs',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminCostSummaryInt', adminCostSummaryFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/archive-client',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminArchiveClientInt', adminArchiveClientFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/admin/manage-user',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminManageUserInt', adminManageUserFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/sow/validate',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('SowValidateInt', sowValidateFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/change-impact',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('ChangeImpactInt', changeImpactFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/test-scripts/generate',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('GenerateTestsInt', generateTestsFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/test-scripts/status/{jobId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2_integrations.HttpLambdaIntegration('TestScriptsStatusInt', testScriptsStatusFn),
      authorizer,
    });
    httpApi.addRoutes({
      path: '/status-report/generate',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('StatusReportInt', statusReportFn),
      authorizer,
    });

    httpApi.addRoutes({
      path: '/admin/update-user',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminUpdateUserInt', adminUpdateUserFn),
      authorizer,
    });
    // Public — no authorizer: user is stuck at MFA challenge so has no full JWT
    httpApi.addRoutes({
      path: '/mfa/request-reset',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('MfaResetRequestInt', mfaResetRequestFn),
    });
    httpApi.addRoutes({
      path: '/admin/mfa-reset-requests',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2_integrations.HttpLambdaIntegration('AdminMfaResetRequestsInt', mfaResetRequestFn),
      authorizer,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'DemoPassword', { value: 'Mitre2025!' });
    new cdk.CfnOutput(this, 'DemoUsers', { value: [
      'admin@platform.com          → admin',
      'project-admin@platform.com  → project_admin',
      'security-admin@platform.com → security_admin',
      'consultant@platform.com     → consultant (assigned to acme + globex)',
      'client@acme.com             → client (acme)',
      'client@globex.com           → client (globex)',
    ].join(' | ') });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'DocsBucketName', { value: docsBucket.bucketName });
    new cdk.CfnOutput(this, 'VectorTableName', { value: vectorTable.tableName });
    new cdk.CfnOutput(this, 'DbClusterArn', { value: dbCluster.clusterArn });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: dbSecret.secretArn });
  }
}

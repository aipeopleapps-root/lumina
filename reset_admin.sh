#!/bin/bash

aws cognito-idp admin-delete-user \
  --user-pool-id us-east-1_Mw0hs5vK4 \
  --username admin@workday-ai.com \
  --region us-east-1

aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_Mw0hs5vK4 \
  --username admin@workday-ai.com \
  --user-attributes \
    Name=email,Value=admin@workday-ai.com \
    Name=email_verified,Value=true \
    Name=custom:tenant_id,Value=platform \
    Name=custom:role,Value=admin \
  --temporary-password "TempAdmin123!" \
  --message-action SUPPRESS \
  --region us-east-1

aws cognito-idp admin-set-user-password \
  --user-pool-id us-east-1_Mw0hs5vK4 \
  --username admin@workday-ai.com \
  --password "AdminPass789!" \
  --permanent \
  --region us-east-1

echo "✅ Admin user created!"
echo "Email: admin@workday-ai.com"
echo "Password: AdminPass789!"

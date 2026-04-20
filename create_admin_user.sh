#!/bin/bash

USER_POOL_ID="us-east-1_Mw0hs5vK4"
EMAIL="admin@workday-ai.com"
PASSWORD="AdminPass123!"

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --user-attributes \
    Name=email,Value="$EMAIL" \
    Name=email_verified,Value=true \
    Name=custom:tenant_id,Value=platform \
    Name=custom:role,Value=admin \
  --temporary-password "$PASSWORD" \
  --message-action SUPPRESS \
  --region us-east-1

echo ""
echo "✅ Admin user created!"
echo "Email: $EMAIL"
echo "Temporary Password: $PASSWORD"
echo ""
echo "Login and you'll be prompted to change password."

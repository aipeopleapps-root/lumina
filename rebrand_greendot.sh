#!/bin/bash

echo "🟢 Rebranding to Green Dot..."

# Replace Deloitte with Green Dot throughout
sed -i '' 's/Deloitte/Green Dot/g' frontend/src/App.tsx
sed -i '' 's/Powered by Deloitte/Powered by Green Dot/g' frontend/src/App.tsx
sed -i '' 's/AI-Powered Workday Advisory by Deloitte/AI-Powered Workday Advisory by Green Dot/g' frontend/src/App.tsx

# README
sed -i '' 's/Deloitte/Green Dot/g' README.md

echo "✅ Rebranding complete!"
echo ""
echo "Changes made:"
echo "  • Deloitte → Green Dot"
echo "  • Tagline: AI-Powered Workday Advisory by Green Dot"

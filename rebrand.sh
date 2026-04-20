#!/bin/bash

echo "🎨 Rebranding to Workday Insight Studio..."

# Frontend - App.tsx
sed -i '' 's/Workday AI Platform/Workday Insight Studio/g' frontend/src/App.tsx
sed -i '' 's/Sign in to the demo/AI-Powered Workday Advisory by Deloitte/g' frontend/src/App.tsx
sed -i '' 's/Demo environment/Powered by Deloitte/g' frontend/src/App.tsx
sed -i '' 's/<div className="text-xs text-slate-500">Tenant<\/div>/<div className="text-xs text-slate-500">Client<\/div>/g' frontend/src/App.tsx

# AdminPanel - Control Center
sed -i '' 's/Admin Portal/Control Center/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/New Tenant/New Client/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/Create New Tenant/Create New Client/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/Tenant ID/Client ID/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/Company Name/Organization Name/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/Create Tenant/Create Client/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/Tenant/Client/g' frontend/src/components/AdminPanel.tsx

# ConsultantPanel - Analysis Workbench
sed -i '' 's/Consultant Portal/Analysis Workbench/g' frontend/src/components/ConsultantPanel.tsx
sed -i '' 's/Consultant insights/Analysis Workbench/g' frontend/src/App.tsx

# CoachPanel - Ask Workday Expert
sed -i '' 's/AI Coach/Ask Workday Expert/g' frontend/src/components/CoachPanel.tsx
sed -i '' 's/AI Coach/Ask Workday Expert/g' frontend/src/App.tsx

# Package.json
sed -i '' 's/"workday-ai-platform-frontend"/"workday-insight-studio-frontend"/g' frontend/package.json

# README
sed -i '' 's/Workday AI Platform/Workday Insight Studio/g' README.md

echo "✅ Rebranding complete!"
echo ""
echo "Changes made:"
echo "  • Platform name: Workday Insight Studio"
echo "  • Tagline: AI-Powered Workday Advisory by Deloitte"
echo "  • Admin Portal → Control Center"
echo "  • Consultant Portal → Analysis Workbench"
echo "  • AI Coach → Ask Workday Expert"
echo "  • Tenant → Client (UI only)"

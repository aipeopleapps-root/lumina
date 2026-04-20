#!/bin/bash

echo "🎨 Applying Deloitte theme colors..."

# App.tsx - Header and buttons
sed -i '' 's/bg-slate-900/bg-deloitte-black/g' frontend/src/App.tsx
sed -i '' 's/hover:bg-slate-800/hover:bg-gray-900/g' frontend/src/App.tsx
sed -i '' 's/text-slate-900/text-deloitte-black/g' frontend/src/App.tsx

# AdminPanel - Buttons
sed -i '' 's/bg-blue-600/bg-deloitte-green/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/hover:bg-blue-700/hover:bg-deloitte-dark-green/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/bg-green-600/bg-deloitte-green/g' frontend/src/components/AdminPanel.tsx
sed -i '' 's/hover:bg-green-700/hover:bg-deloitte-dark-green/g' frontend/src/components/AdminPanel.tsx

# ConsultantPanel - Buttons
sed -i '' 's/bg-slate-900/bg-deloitte-green/g' frontend/src/components/ConsultantPanel.tsx
sed -i '' 's/hover:bg-slate-800/hover:bg-deloitte-dark-green/g' frontend/src/components/ConsultantPanel.tsx

# DocumentsPanel - Buttons  
sed -i '' 's/bg-slate-900/bg-deloitte-green/g' frontend/src/components/DocumentsPanel.tsx
sed -i '' 's/hover:bg-slate-800/hover:bg-deloitte-dark-green/g' frontend/src/components/DocumentsPanel.tsx

echo "✅ Deloitte theme applied!"

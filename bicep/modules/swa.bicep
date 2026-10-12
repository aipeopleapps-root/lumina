// Phase 8 — Static Web Apps hosting for the frontend SPA.
//
// Created standalone (no `repositoryUrl`/`branch`/`repositoryToken` git-integration
// params) rather than wired to GitHub at creation time — embedding a GitHub PAT in this
// Bicep would be a real secret-handling decision, and Phase 9 ("CI/CD: GitHub Actions
// Azure OIDC + Bicep deploy") is explicitly where this migration already planned to make
// that call (OIDC federated credentials, not a long-lived PAT). Until Phase 9 wires that
// up, deploy manually with the Static Web Apps CLI (`swa deploy`) using this resource's
// deployment token, or connect GitHub through the Azure Portal's one-click flow (which
// handles the OAuth token exchange itself, unlike a Bicep-embedded PAT would).
//
// **Vite env vars are a build-time concern, not a runtime one** — unlike a server, this
// SPA's `VITE_API_ENDPOINT`/`VITE_AZURE_*` values (frontend/.env.example) get inlined into
// the JS bundle by `vite build`, so there is no `Microsoft.Web/staticSites/config` app
// settings resource here the way compute.bicep has one for the Function App. Whatever CI
// step (Phase 9) runs `npm run build` needs those as build-time env vars / a `.env.local`
// written just before the build, not as Azure resource configuration.

@description('Azure region — Static Web Apps is only available in a subset of regions, independent of this stack\'s main `location` param; see az staticwebapp create --location default choices if this region isn\'t supported')
param location string = 'eastus2'

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('Static Web Apps SKU — Free is sufficient for a 2-demo-tenant deployment; Standard adds custom domain SLA/more staging environments if ever needed')
param sku string = 'Free'

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${namePrefix}-swa'
  location: location
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    // No `repositoryUrl` — see module docstring.
    provider: 'None'
  }
}

output name string = staticWebApp.name
output defaultHostname string = staticWebApp.properties.defaultHostname

// Phase 2 — Networking
// Mirrors the AWS VPC in infra/lib/stack.ts:26-33 (2 AZs, 1 NAT gateway, public/private-with-egress subnets),
// plus a private-endpoint subnet as the deliberate improvement over the AWS side (no VPC endpoints there).

@description('Azure region for all networking resources')
param location string

@description('Naming prefix for all resources (e.g. "lumina")')
param namePrefix string

@description('VNet address space')
param vnetAddressPrefix string = '10.20.0.0/16'

@description('Subnet for Function App VNet integration (outbound to AI Foundry/OpenAI/Graph/etc via NAT)')
param appSubnetPrefix string = '10.20.1.0/24'

@description('Subnet delegated to Postgres Flexible Server (VNet-integrated)')
param dataSubnetPrefix string = '10.20.2.0/24'

@description('Subnet for private endpoints (Cosmos DB, Blob Storage, Key Vault)')
param peSubnetPrefix string = '10.20.3.0/24'

resource natPip 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: '${namePrefix}-nat-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2023-11-01' = {
  name: '${namePrefix}-nat'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIpAddresses: [
      {
        id: natPip.id
      }
    ]
  }
}

// Mirrors dbSg (stack.ts:66-69, 313-317): TCP 5432 ingress restricted to the VNet CIDR only.
resource dataNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${namePrefix}-data-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowPostgresFromVnet'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '5432'
          sourceAddressPrefix: vnetAddressPrefix
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource peNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${namePrefix}-pe-nsg'
  location: location
  properties: {
    securityRules: []
  }
}

resource appNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${namePrefix}-app-nsg'
  location: location
  properties: {
    securityRules: []
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-app'
        properties: {
          addressPrefix: appSubnetPrefix
          networkSecurityGroup: {
            id: appNsg.id
          }
          natGateway: {
            id: natGateway.id
          }
          // 'Microsoft.App/environments', not the classic 'Microsoft.Web/serverFarms' — Flex
          // Consumption's VNet integration is built on Container-Apps-style networking
          // infrastructure under the hood, unlike Premium/Dedicated plans. Confirmed live
          // (Phase 7 session 14): `az functionapp vnet-integration add` against a real FC1
          // Flex Consumption app auto-registered the `Microsoft.App` resource provider and
          // required exactly this delegation — the classic delegation fails deployment with
          // `SubnetMissingRequiredDelegation`.
          delegations: [
            {
              name: 'webapp-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-data'
        properties: {
          addressPrefix: dataSubnetPrefix
          networkSecurityGroup: {
            id: dataNsg.id
          }
          delegations: [
            {
              name: 'postgres-delegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: peSubnetPrefix
          networkSecurityGroup: {
            id: peNsg.id
          }
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output appSubnetId string = vnet.properties.subnets[0].id
output dataSubnetId string = vnet.properties.subnets[1].id
output peSubnetId string = vnet.properties.subnets[2].id

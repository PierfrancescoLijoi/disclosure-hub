data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  name = "${var.workload}-${var.environment}"
  # Globally unique names (registry, vault, database server) carry a stable random suffix.
  unique = "${var.workload}${var.environment}${random_string.suffix.result}"
  tags = merge(var.tags, {
    environment = var.environment
    workload    = var.workload
    managed_by  = "terraform"
  })

  aca_subnet_cidr = cidrsubnet(var.address_space, 1, 0)  # /23: what a Container Apps environment needs
  pg_subnet_cidr  = cidrsubnet(var.address_space, 6, 32) # /28 in the other half
  pe_subnet_cidr  = cidrsubnet(var.address_space, 6, 33) # /28: private endpoints (registry, vault)
  acr_agent_cidr  = cidrsubnet(var.address_space, 5, 17) # /27: registry build agents (ACR Tasks agent pool)
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = [var.address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "aca" {
  name                 = "snet-aca"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.aca_subnet_cidr]
  # The vault firewall admits this subnet by service endpoint.
  service_endpoints = ["Microsoft.KeyVault"]

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.pg_subnet_cidr]

  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# With private_ingress nothing reaches this subnet from the internet: Front Door comes in over Private
# Link, which is not a subnet rule. Without it, public HTTPS in and nothing else added (Azure's default
# rules still apply). Outbound leaves through the NAT gateway below when private_data_plane is on.
resource "azurerm_network_security_group" "aca" {
  name                = "nsg-${local.name}-aca"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

# A separate rule, not an inline block: an inline rule removed from the configuration would stay on the
# group (the provider keeps rules it is not told about), so turning private_ingress on later would not close it.
#trivy:ignore:AZU-0047 internet-facing HTTPS application by design when private_ingress is off; every request needs an Entra token
resource "azurerm_network_security_rule" "aca_https_from_internet" {
  count                       = var.private_ingress ? 0 : 1
  name                        = "allow-https-from-internet"
  priority                    = 100
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = "443"      # lint:allow public the platform is an internet-facing HTTPS app when private_ingress is off; every request needs an Entra token
  source_address_prefix       = "Internet" # lint:allow public same rule
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.main.name
  network_security_group_name = azurerm_network_security_group.aca.name
}

resource "azurerm_subnet_network_security_group_association" "aca" {
  subnet_id                 = azurerm_subnet.aca.id
  network_security_group_id = azurerm_network_security_group.aca.id
}

# The database accepts connections from the application subnet and from nowhere else in the network.
resource "azurerm_network_security_group" "postgres" {
  name                = "nsg-${local.name}-postgres"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags

  security_rule {
    name                       = "allow-app-to-postgres"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "5432"
    source_address_prefix      = local.aca_subnet_cidr
    destination_address_prefix = "*"
  }

  # The second region's replica pulls changes from here (dr.tf).
  dynamic "security_rule" {
    for_each = var.dr_location == null ? [] : [1]
    content {
      name                       = "allow-dr-replica-to-postgres"
      priority                   = 110
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "5432"
      source_address_prefix      = local.dr_pg_cidr
      destination_address_prefix = "*"
    }
  }

  security_rule {
    name                       = "deny-everything-else-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*" # lint:allow public this rule is a Deny
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "postgres" {
  subnet_id                 = azurerm_subnet.postgres.id
  network_security_group_id = azurerm_network_security_group.postgres.id
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.name}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "link-${local.name}"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  tags                  = local.tags
}

# ------------------------------------------------------------------ egress: one known address

# Outbound traffic otherwise leaves from addresses Azure picks and may change. One NAT gateway gives the
# environment a single stable address to give to partners and to read in logs. It does not filter: the
# step after it is Azure Firewall in the hub of a landing zone (infra/azure-landing-zone/README.md).
resource "azurerm_public_ip" "nat" {
  count               = var.private_data_plane ? 1 : 0
  name                = "pip-${local.name}-nat"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_nat_gateway" "main" {
  count                   = var.private_data_plane ? 1 : 0
  name                    = "natgw-${local.name}"
  location                = azurerm_resource_group.main.location
  resource_group_name     = azurerm_resource_group.main.name
  sku_name                = "Standard"
  idle_timeout_in_minutes = 10
  tags                    = local.tags
}

resource "azurerm_nat_gateway_public_ip_association" "main" {
  count                = var.private_data_plane ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.main[0].id
  public_ip_address_id = azurerm_public_ip.nat[0].id
}

# The registry build agents pull base images from outside: same single egress address as the apps.
resource "azurerm_subnet_nat_gateway_association" "acr_agents" {
  count          = var.private_data_plane ? 1 : 0
  subnet_id      = azurerm_subnet.acr_agents[0].id
  nat_gateway_id = azurerm_nat_gateway.main[0].id
}

resource "azurerm_subnet_nat_gateway_association" "aca" {
  count          = var.private_data_plane ? 1 : 0
  subnet_id      = azurerm_subnet.aca.id
  nat_gateway_id = azurerm_nat_gateway.main[0].id
}

# ------------------------------------------------------------------ private endpoints (registry, vault)

resource "azurerm_subnet" "private_endpoints" {
  count                = var.private_data_plane ? 1 : 0
  name                 = "snet-pe"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.pe_subnet_cidr]
}

# Where the registry build agents run. The agent pool is what lets `az acr build` reach a registry that has
# no public endpoint (ACR Tasks is not a trusted service that can bypass the network rules).
resource "azurerm_subnet" "acr_agents" {
  count                = var.private_data_plane ? 1 : 0
  name                 = "snet-acr-agents"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [local.acr_agent_cidr]
}

resource "azurerm_private_dns_zone" "acr" {
  count               = var.private_data_plane ? 1 : 0
  name                = "privatelink.azurecr.io"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "acr" {
  count                 = var.private_data_plane ? 1 : 0
  name                  = "link-${local.name}"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.acr[0].name
  virtual_network_id    = azurerm_virtual_network.main.id
  tags                  = local.tags
}

resource "azurerm_private_dns_zone" "vault" {
  count               = var.private_data_plane ? 1 : 0
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "vault" {
  count                 = var.private_data_plane ? 1 : 0
  name                  = "link-${local.name}"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.vault[0].name
  virtual_network_id    = azurerm_virtual_network.main.id
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "acr" {
  count               = var.private_data_plane ? 1 : 0
  name                = "pe-${local.name}-acr"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints[0].id
  tags                = local.tags

  private_service_connection {
    name                           = "acr"
    private_connection_resource_id = azurerm_container_registry.main.id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr"
    private_dns_zone_ids = [azurerm_private_dns_zone.acr[0].id]
  }
}

resource "azurerm_private_endpoint" "vault" {
  count               = var.private_data_plane ? 1 : 0
  name                = "pe-${local.name}-kv"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.private_endpoints[0].id
  tags                = local.tags

  private_service_connection {
    name                           = "vault"
    private_connection_resource_id = azurerm_key_vault.main.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.vault[0].id]
  }
}

# Default rules only (no inbound from the internet, outbound open for the registry's own endpoints): the groups
# exist so every subnet is governed by one and a rule can be added in one place.
resource "azurerm_network_security_group" "private_endpoints" {
  count               = var.private_data_plane ? 1 : 0
  name                = "nsg-${local.name}-pe"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_subnet_network_security_group_association" "private_endpoints" {
  count                     = var.private_data_plane ? 1 : 0
  subnet_id                 = azurerm_subnet.private_endpoints[0].id
  network_security_group_id = azurerm_network_security_group.private_endpoints[0].id
}

resource "azurerm_network_security_group" "acr_agents" {
  count               = var.private_data_plane ? 1 : 0
  name                = "nsg-${local.name}-acr-agents"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_subnet_network_security_group_association" "acr_agents" {
  count                     = var.private_data_plane ? 1 : 0
  subnet_id                 = azurerm_subnet.acr_agents[0].id
  network_security_group_id = azurerm_network_security_group.acr_agents[0].id
}

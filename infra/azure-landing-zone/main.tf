data "azurerm_client_config" "current" {}

locals {
  parent = coalesce(var.parent_management_group_id, "/providers/Microsoft.Management/managementGroups/${data.azurerm_client_config.current.tenant_id}")
}

# The hierarchy, kept shallow on purpose: governance is inherited downwards, so the groups are drawn where the
# rules differ, not where the org chart does.
#
#   <org>
#   |-- <org>-platform         shared services: connectivity (hub network, firewall), identity, management (logs)
#   |-- <org>-landing-zones    workloads
#   |   |-- <org>-prod         production subscriptions (Disclosure Hub prod: infra/azure, environment = prod)
#   |   `-- <org>-nonprod      test and dev subscriptions
#   |-- <org>-sandbox          experiments: only the org-wide policies (regions, tags) apply, not the network-exposure ones
#   `-- <org>-decommissioned   subscriptions waiting to be deleted
resource "azurerm_management_group" "org" {
  name                       = var.org
  display_name               = var.org_display_name
  parent_management_group_id = local.parent
}

resource "azurerm_management_group" "platform" {
  name                       = "${var.org}-platform"
  display_name               = "Platform"
  parent_management_group_id = azurerm_management_group.org.id
}

resource "azurerm_management_group" "landing_zones" {
  name                       = "${var.org}-landing-zones"
  display_name               = "Landing zones"
  parent_management_group_id = azurerm_management_group.org.id
}

resource "azurerm_management_group" "prod" {
  name                       = "${var.org}-prod"
  display_name               = "Production"
  parent_management_group_id = azurerm_management_group.landing_zones.id
}

resource "azurerm_management_group" "nonprod" {
  name                       = "${var.org}-nonprod"
  display_name               = "Non-production"
  parent_management_group_id = azurerm_management_group.landing_zones.id
}

resource "azurerm_management_group" "sandbox" {
  name                       = "${var.org}-sandbox"
  display_name               = "Sandbox"
  parent_management_group_id = azurerm_management_group.org.id
}

resource "azurerm_management_group" "decommissioned" {
  name                       = "${var.org}-decommissioned"
  display_name               = "Decommissioned"
  parent_management_group_id = azurerm_management_group.org.id
}

locals {
  scope_ids = {
    org           = azurerm_management_group.org.id
    platform      = azurerm_management_group.platform.id
    landing_zones = azurerm_management_group.landing_zones.id
    prod          = azurerm_management_group.prod.id
    nonprod       = azurerm_management_group.nonprod.id
    sandbox       = azurerm_management_group.sandbox.id
  }

  subscription_placement = merge(
    { for s in var.subscriptions.platform : s => azurerm_management_group.platform.id },
    { for s in var.subscriptions.prod : s => azurerm_management_group.prod.id },
    { for s in var.subscriptions.nonprod : s => azurerm_management_group.nonprod.id },
    { for s in var.subscriptions.sandbox : s => azurerm_management_group.sandbox.id },
  )
}

resource "azurerm_management_group_subscription_association" "this" {
  for_each            = local.subscription_placement
  management_group_id = each.value
  subscription_id     = "/subscriptions/${each.key}"
}

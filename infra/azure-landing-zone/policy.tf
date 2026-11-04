# Guardrails assigned once, at the top, so every subscription under it inherits them. Built-in definitions are
# found by display name at plan time: a name Microsoft has changed fails the plan loudly instead of silently
# assigning nothing. enforce_policies = false (default) makes them report only.

locals {
  # Policies whose effect can be Deny take it only when enforce_policies is on; the others only ever report.
  effect = var.enforce_policies ? "Deny" : "Audit"
}

data "azurerm_policy_definition_built_in" "allowed_locations" {
  display_name = "Allowed locations"
}

data "azurerm_policy_definition_built_in" "require_tag_on_rg" {
  display_name = "Require a tag on resource groups"
}

data "azurerm_policy_definition_built_in" "key_vault_no_public" {
  display_name = "Azure Key Vault should disable public network access"
}

data "azurerm_policy_definition_built_in" "registry_no_public" {
  display_name = "Container registries should not allow unrestricted network access"
}

data "azurerm_policy_definition_built_in" "front_door_premium" {
  display_name = "Azure Front Door profiles should use Premium tier that supports managed WAF rules and private link"
}

resource "azurerm_management_group_policy_assignment" "allowed_locations" {
  name                 = "allowed-locations"
  display_name         = "Resources only in approved regions"
  management_group_id  = azurerm_management_group.org.id
  policy_definition_id = data.azurerm_policy_definition_built_in.allowed_locations.id
  enforce              = var.enforce_policies
  parameters           = jsonencode({ listOfAllowedLocations = { value = var.allowed_locations } })
}

resource "azurerm_management_group_policy_assignment" "required_tag" {
  for_each             = toset(var.required_tags)
  name                 = "tag-${substr(replace(each.key, "_", "-"), 0, 20)}"
  display_name         = "Resource groups must carry the tag ${each.key}"
  management_group_id  = azurerm_management_group.org.id
  policy_definition_id = data.azurerm_policy_definition_built_in.require_tag_on_rg.id
  enforce              = var.enforce_policies
  parameters           = jsonencode({ tagName = { value = each.key } })
}

# Network exposure and edge tier: reported on every workload subscription, not in the sandbox, where people try things.
resource "azurerm_management_group_policy_assignment" "key_vault_private" {
  name                 = "kv-no-public-access"
  display_name         = "Key Vaults should not be reachable from the internet"
  management_group_id  = azurerm_management_group.landing_zones.id
  policy_definition_id = data.azurerm_policy_definition_built_in.key_vault_no_public.id
  enforce              = var.enforce_policies
  parameters           = jsonencode({ effect = { value = local.effect } })
}

resource "azurerm_management_group_policy_assignment" "registry_private" {
  name                 = "acr-no-public-access"
  display_name         = "Container registries should not allow unrestricted network access"
  management_group_id  = azurerm_management_group.landing_zones.id
  policy_definition_id = data.azurerm_policy_definition_built_in.registry_no_public.id
  enforce              = var.enforce_policies
  parameters           = jsonencode({ effect = { value = local.effect } })
}

# Audit only, never Deny: a development environment may keep the Standard tier on purpose (infra/azure, private_ingress = false).
resource "azurerm_management_group_policy_assignment" "front_door_premium" {
  name                 = "afd-premium"
  display_name         = "Front Door should be Premium (managed WAF rules, Private Link)"
  management_group_id  = azurerm_management_group.prod.id
  policy_definition_id = data.azurerm_policy_definition_built_in.front_door_premium.id
  enforce              = false
  parameters           = jsonencode({ effect = { value = "Audit" } })
}

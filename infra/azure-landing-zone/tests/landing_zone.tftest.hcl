mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "11111111-1111-1111-1111-111111111111"
      subscription_id = "22222222-2222-2222-2222-222222222222"
    }
  }
  mock_data "azurerm_policy_definition_built_in" {
    defaults = {
      id = "/providers/Microsoft.Authorization/policyDefinitions/00000000-0000-0000-0000-00000000aaaa"
    }
  }
  mock_resource "azurerm_management_group" {
    defaults = {
      id = "/providers/Microsoft.Management/managementGroups/mock"
    }
  }
}

variables {
  org              = "contoso"
  org_display_name = "Contoso"
  subscriptions = {
    platform = ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]
    prod     = ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]
    nonprod  = ["cccccccc-cccc-cccc-cccc-cccccccccccc"]
  }
  rbac = {
    platform_owners = { group_object_id = "dddddddd-dddd-dddd-dddd-dddddddddddd", role = "Owner", scope = "platform" }
    security_reader = { group_object_id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", role = "Reader", scope = "org" }
  }
}

run "the_hierarchy_is_shallow_and_each_subscription_sits_in_one_place" {
  command = apply

  assert {
    condition     = azurerm_management_group.org.name == "contoso" && azurerm_management_group.prod.name == "contoso-prod" && azurerm_management_group.decommissioned.name == "contoso-decommissioned"
    error_message = "Groups are named from the org prefix."
  }
  assert {
    condition     = length(azurerm_management_group_subscription_association.this) == 3 && azurerm_management_group_subscription_association.this["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"].subscription_id == "/subscriptions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    error_message = "Each listed subscription is associated once, by full resource id."
  }
}

run "policies_report_first_and_enforce_when_asked" {
  command = apply

  assert {
    condition     = azurerm_management_group_policy_assignment.allowed_locations.enforce == false && alltrue([for k, a in azurerm_management_group_policy_assignment.required_tag : a.enforce == false])
    error_message = "By default policies only report."
  }
  assert {
    condition     = length(azurerm_management_group_policy_assignment.required_tag) == 2
    error_message = "owner and cost_centre are both required on resource groups."
  }
  assert {
    condition     = jsondecode(azurerm_management_group_policy_assignment.key_vault_private.parameters).effect.value == "Audit"
    error_message = "Network-exposure policies audit while not enforced."
  }
}

run "enforcing_turns_the_deny_policies_on" {
  command = apply
  variables {
    enforce_policies = true
  }

  assert {
    condition     = azurerm_management_group_policy_assignment.allowed_locations.enforce == true && jsondecode(azurerm_management_group_policy_assignment.registry_private.parameters).effect.value == "Deny"
    error_message = "Enforcement is one switch."
  }
  assert {
    condition     = azurerm_management_group_policy_assignment.front_door_premium.enforce == false
    error_message = "The Front Door tier policy never blocks: a dev environment may stay Standard."
  }
}

run "groups_get_roles_at_the_scope_named" {
  command = apply

  assert {
    condition     = length(azurerm_role_assignment.group) == 2 && azurerm_role_assignment.group["security_reader"].principal_type == "Group"
    error_message = "Role assignments go to groups."
  }
}

run "owner_is_refused_over_production" {
  command = plan
  variables {
    rbac = { bad = { group_object_id = "dddddddd-dddd-dddd-dddd-dddddddddddd", role = "Owner", scope = "prod" } }
  }
  expect_failures = [var.rbac]
}

run "a_subscription_cannot_sit_in_two_places" {
  command = plan
  variables {
    subscriptions = {
      prod    = ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]
      nonprod = ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]
    }
  }
  expect_failures = [var.subscriptions]
}

run "global_must_stay_in_the_allowed_locations" {
  command = plan
  variables {
    allowed_locations = ["uksouth"]
  }
  expect_failures = [var.allowed_locations]
}

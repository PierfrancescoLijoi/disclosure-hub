# Access by group at the place it is needed; it passes down to everything below. Owner is refused above the
# platform and non-production groups (variables.tf), so that nobody inherits ownership of production.
resource "azurerm_role_assignment" "group" {
  for_each             = var.rbac
  scope                = local.scope_ids[each.value.scope]
  role_definition_name = each.value.role
  principal_id         = each.value.group_object_id
  principal_type       = "Group"
}

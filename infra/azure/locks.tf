# A mistaken `terraform destroy` or portal click cannot remove the data or the vault. To destroy on
# purpose, set enable_resource_locks = false, apply, then destroy.
resource "azurerm_management_lock" "postgres" {
  count      = var.enable_resource_locks ? 1 : 0
  name       = "do-not-delete"
  scope      = azurerm_postgresql_flexible_server.main.id
  lock_level = "CanNotDelete"
  notes      = "Holds the announcement records and the audit log."
}

resource "azurerm_management_lock" "vault" {
  count      = var.enable_resource_locks ? 1 : 0
  name       = "do-not-delete"
  scope      = azurerm_key_vault.main.id
  lock_level = "CanNotDelete"
  notes      = "Application secrets."
}

# Holds the one secret this platform can have (the model provider key) and anything added later.
# Nothing in this module writes a secret value: it would end up in the Terraform state.
resource "azurerm_key_vault" "main" {
  # checkov:skip=CKV2_AZURE_32: the private endpoint exists when private_data_plane is on (the default); the dev configuration admits only the application subnet through the firewall.
  name                       = "kv-${local.unique}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 90
  # Closed to the internet when the private endpoint carries the traffic, unless an operator's address is
  # listed (first-time secrets); open-with-firewall in the dev configuration.
  public_network_access_enabled = !var.private_data_plane || length(var.key_vault_allowed_ips) > 0 # lint:allow public the firewall below is what restricts it
  tags                          = local.tags

  network_acls {
    default_action             = "Deny"
    bypass                     = "AzureServices"
    virtual_network_subnet_ids = [azurerm_subnet.aca.id]
    ip_rules                   = var.key_vault_allowed_ips
  }
}

# Whoever runs Terraform or the first-time setup may add the secret by hand: from inside the network, or
# from an address listed in key_vault_allowed_ips for the time it takes (README, "First apply").
resource "azurerm_role_assignment" "vault_admin" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = var.dba_group_object_id
  principal_type       = "Group"
}

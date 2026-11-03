# One registry per environment. Images are built once and promoted by digest. Standard is enough for a
# small company; Premium adds private endpoints and geo-replication when the second region arrives.
resource "azurerm_container_registry" "main" {
  # checkov:skip=CKV_AZURE_164: signed images, quarantine, dedicated data endpoints, retention policy, zone redundancy, geo-replication and a private endpoint are Premium features; Standard is the deliberate small-company choice (docs/SIZING.md), images are promoted by digest.
  # checkov:skip=CKV_AZURE_165: geo-replication is Premium and there is one region by design.
  # checkov:skip=CKV_AZURE_166: image quarantine is Premium.
  # checkov:skip=CKV_AZURE_237: dedicated data endpoints are Premium.
  # checkov:skip=CKV_AZURE_167: the untagged-manifest retention policy is Premium; the pipeline prunes old digests instead.
  # checkov:skip=CKV_AZURE_233: zone redundancy of the registry is Premium.
  # checkov:skip=CKV_AZURE_139: the deployment pipeline (GitHub-hosted) pushes over the internet; a private endpoint needs Premium and self-hosted runners.
  name                          = "acr${local.unique}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = "Standard"
  admin_enabled                 = false # identities only, no shared registry password
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
  tags                          = local.tags
}

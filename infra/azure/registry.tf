# One registry per environment. Images are built once and promoted by digest.
#
# private_data_plane (default): Premium, no public endpoint, reached through a private endpoint; builds run in
# an agent pool inside the network. Off: Standard, public endpoint with identities only (dev).
# Premium also brings zone redundancy and the geo-replication the second region (dr.tf) uses.
resource "azurerm_container_registry" "main" {
  # checkov:skip=CKV_AZURE_164: signed-image trust (content trust) is not used: images are promoted by digest from one pipeline, and the deployment identity is the only one with AcrPush.
  # checkov:skip=CKV_AZURE_166: image quarantine needs a scanning pipeline that releases images; the pipeline scans before promoting instead.
  # checkov:skip=CKV_AZURE_237: dedicated data endpoints add one more private endpoint record per region; the registry's regional endpoints already sit behind the private endpoint.
  # checkov:skip=CKV_AZURE_167: the untagged-manifest retention policy is a preview feature; the pipeline prunes old digests instead.
  # checkov:skip=CKV_AZURE_233: zone redundancy is on when Premium; Standard (private_data_plane = false) cannot have it.
  # checkov:skip=CKV_AZURE_165: geo-replication is on when dr_location is set; one region without it by design.
  # checkov:skip=CKV_AZURE_139: public access is off when private_data_plane is on (the default); it is on only in the dev configuration.
  name                          = "acr${local.unique}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = var.private_data_plane ? "Premium" : "Standard"
  admin_enabled                 = false # identities only, no shared registry password
  anonymous_pull_enabled        = false
  public_network_access_enabled = !var.private_data_plane
  zone_redundancy_enabled       = var.private_data_plane
  tags                          = local.tags

  dynamic "georeplications" {
    for_each = var.private_data_plane && var.dr_location != null ? [var.dr_location] : []
    content {
      location                = georeplications.value
      zone_redundancy_enabled = true
      tags                    = local.tags
    }
  }
}

# Builds inside the network. S1 is the smallest tier; the pool bills while it exists, so it is the one
# resource here that costs money for doing nothing (README, "What it costs").
resource "azurerm_container_registry_agent_pool" "build" {
  count                     = var.private_data_plane ? 1 : 0
  name                      = "build"
  resource_group_name       = azurerm_resource_group.main.name
  location                  = azurerm_resource_group.main.location
  container_registry_name   = azurerm_container_registry.main.name
  instance_count            = 1
  tier                      = "S1"
  virtual_network_subnet_id = azurerm_subnet.acr_agents[0].id
  tags                      = local.tags
}

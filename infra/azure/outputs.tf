output "app_url" {
  description = "Where people open the platform: the Front Door address when it is on, else the container app."
  value       = local.public_base_url
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "registry_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "postgres_fqdn" {
  description = "Private address; resolves only inside the virtual network."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "database_roles" {
  description = "Database role names to create once with scripts/bootstrap-roles.sql (they equal the identities' names)."
  value = {
    migrate = azurerm_user_assigned_identity.migrate.name
    app     = azurerm_user_assigned_identity.app.name
  }
}

output "migrate_job" {
  value = azurerm_container_app_job.migrate.name
}

output "api_app_client_id" {
  description = "OIDC audience of the API."
  value       = azuread_application.api.client_id
}

output "web_app_client_id" {
  description = "Client id of the browser application (public client, no secret)."
  value       = azuread_application.web.client_id
}

output "deploy_identity_client_id" {
  description = "Set as AZURE_CLIENT_ID in the GitHub environment; null when github_repository is not set."
  value       = one(azurerm_user_assigned_identity.deploy[*].client_id)
}

output "tenant_id" {
  value = data.azurerm_client_config.current.tenant_id
}

# Tenant-level state: its own storage account and key, never the workload's. Settings are passed at init time:
#   terraform init -backend-config="resource_group_name=..." -backend-config="storage_account_name=..." \
#                  -backend-config="container_name=tfstate" -backend-config="key=landing-zone.tfstate"
terraform { # lint:allow pin required_version and providers are pinned in versions.tf
  backend "azurerm" {
    use_azuread_auth = true # Entra sign-in to the state account, no access key
  }
}

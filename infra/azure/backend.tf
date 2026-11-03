# State lives in a storage account that is created once, outside this configuration (README, step 1).
# The rest of the settings are passed at init time so the same code serves every environment:
#   terraform init -backend-config="resource_group_name=..." -backend-config="storage_account_name=..." \
#                  -backend-config="container_name=tfstate" -backend-config="key=dhub-<environment>.tfstate"
terraform { # lint:allow pin required_version and providers are pinned in versions.tf
  backend "azurerm" {
    use_azuread_auth = true # Entra sign-in to the state account, no access key
  }
}

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.40"
    }
  }
}

provider "azurerm" {
  features {}
  # Management groups and policy assignments at management-group scope do not live in a subscription, but the
  # provider still signs in through one. Providers are registered by the platform team.
  resource_provider_registrations = "none"
}

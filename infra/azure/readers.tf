# The reader side: where announcements go after they are published. The local twin sends mail to Mailpit
# over SMTP; here the same code sends through Azure Communication Services Email with the app's managed
# identity, so no SMTP password or connection string exists anywhere.

resource "azurerm_email_communication_service" "main" {
  count               = var.enable_reader_email ? 1 : 0
  name                = "acs-email-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.communication_data_location
  tags                = local.tags
}

# An Azure-managed sender domain works at once (DoNotReply@<guid>.azurecomm.net) and is limited in volume;
# a customer domain needs DNS records the platform team owns, so it is a later change, not a default.
resource "azurerm_email_communication_service_domain" "main" {
  count             = var.enable_reader_email ? 1 : 0
  name              = "AzureManagedDomain" # the only name Azure accepts for a managed domain
  email_service_id  = azurerm_email_communication_service.main[0].id
  domain_management = "AzureManaged"
  tags              = local.tags
}

resource "azurerm_communication_service" "main" {
  count               = var.enable_reader_email ? 1 : 0
  name                = "acs-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.communication_data_location
  tags                = local.tags
}

resource "azurerm_communication_service_email_domain_association" "main" {
  count                    = var.enable_reader_email ? 1 : 0
  communication_service_id = azurerm_communication_service.main[0].id
  email_service_domain_id  = azurerm_email_communication_service_domain.main[0].id
}

# The built-in role Microsoft documents for sending with an Entra identity. It is broader than sending
# (it manages the Communication resources); a custom role limited to send is the tightening (README, first-apply item 9).
resource "azurerm_role_assignment" "app_send_email" {
  count                = var.enable_reader_email ? 1 : 0
  scope                = azurerm_communication_service.main[0].id
  role_definition_name = "Communication and Email Service Owner"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

locals {
  # Where links in mail and in the feed point: the edge when there is one, else the app's own address.
  # (The app address is built from names, not read from the app, so the app can use it without a cycle.)
  public_base_url = var.enable_front_door ? "https://${azurerm_cdn_frontdoor_endpoint.main[0].host_name}" : "https://${local.api_app_name}.${azurerm_container_app_environment.main.default_domain}"

  # Read by the processes that serve readers or notify them (api and the event consumers), not by the publication worker.
  reader_env = merge(
    {
      PUBLIC_BASE_URL = local.public_base_url
      WEBHOOKS        = "1"
      EMAIL_TRANSPORT = var.enable_reader_email ? "acs" : "off"
    },
    var.enable_reader_email ? {
      ACS_ENDPOINT = "https://${azurerm_communication_service.main[0].name}.communication.azure.com"
      EMAIL_FROM   = "DoNotReply@${azurerm_email_communication_service_domain.main[0].mail_from_sender_domain}"
    } : {},
  )

  reader_token_secret = {
    name                = "reader-token-key"
    key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${var.reader_token_secret_name}"
    identity            = azurerm_user_assigned_identity.app.id
  }
}

# -------------------------------------------------------------------------------------------------
# Who may call the platform (people, via Entra ID) and what the platform may touch (workloads, via
# managed identities). No client secret and no database password exists anywhere in this module.
# -------------------------------------------------------------------------------------------------

locals {
  # The five roles the server understands (apps/server/src/domain/roles.ts), exposed as Entra app roles.
  app_roles = { # lint:allow secret "company_secretary" is a job title, not a credential
    author            = "Drafts announcements and submits them for review."
    company_secretary = "Reviews wording and confirms it is ready to approve."
    legal             = "Gives the legal sign-off."
    cfo               = "Gives the financial sign-off."
    publisher         = "Publishes an approved announcement to the market."
  }

  # Known before the container app exists (<app name>.<environment default domain>), so the browser app
  # registration does not depend on the app it is registered for.
  api_app_name = "ca-${local.name}-api"
  app_url      = "https://${local.api_app_name}.${azurerm_container_app_environment.main.default_domain}"
}

resource "random_uuid" "scope_access" {}

resource "random_uuid" "app_role" {
  for_each = local.app_roles
}

# ------------------------------------------------------------------ the API (resource) registration

resource "azuread_application" "api" {
  display_name     = "${local.name} api"
  sign_in_audience = "AzureADMyOrg" # this tenant only
  owners           = [data.azurerm_client_config.current.object_id]

  api {
    # The server verifies v2.0 tokens: issuer .../v2.0 and the audience is the application's client id.
    requested_access_token_version = 2

    oauth2_permission_scope {
      id                         = random_uuid.scope_access.result
      value                      = "access_as_user"
      type                       = "User"
      admin_consent_display_name = "Use ${local.name}"
      admin_consent_description  = "Use the disclosure platform as the signed-in user."
      user_consent_display_name  = "Use ${local.name}"
      user_consent_description   = "Use the disclosure platform as you."
      enabled                    = true
    }
  }

  dynamic "app_role" {
    for_each = local.app_roles
    content {
      id                   = random_uuid.app_role[app_role.key].result
      value                = app_role.key
      display_name         = replace(title(replace(app_role.key, "_", " ")), " ", "")
      description          = app_role.value
      allowed_member_types = ["User"]
      enabled              = true
    }
  }
}

resource "azuread_application_identifier_uri" "api" {
  application_id = azuread_application.api.id
  identifier_uri = "api://${azuread_application.api.client_id}"
}

resource "azuread_service_principal" "api" {
  client_id = azuread_application.api.client_id
  owners    = [data.azurerm_client_config.current.object_id]
  # Only people assigned a role (directly or through a group) can obtain a token for the API.
  app_role_assignment_required = true
}

# Members of each Entra group receive that role in their token. Group-to-role assignment needs Entra ID P1.
resource "azuread_app_role_assignment" "group" {
  for_each            = var.role_groups
  app_role_id         = random_uuid.app_role[each.key].result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.api.object_id
}

# ------------------------------------------------------------------ the browser app registration

resource "azuread_application" "web" {
  display_name     = "${local.name} web"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azurerm_client_config.current.object_id]

  # Authorization Code with PKCE for a public client: no secret exists.
  single_page_application {
    redirect_uris = concat(["${local.app_url}/"], [for u in var.extra_redirect_uris : u])
  }

  required_resource_access {
    resource_app_id = azuread_application.api.client_id
    resource_access {
      id   = random_uuid.scope_access.result
      type = "Scope"
    }
  }
}

resource "azuread_service_principal" "web" {
  client_id = azuread_application.web.client_id
  owners    = [data.azurerm_client_config.current.object_id]
}

# The browser app is trusted to call the API, so people are not asked to consent to something their own
# company's administrators already configured.
resource "azuread_application_pre_authorized" "web" {
  application_id       = azuread_application.api.id
  authorized_client_id = azuread_application.web.client_id
  permission_ids       = [random_uuid.scope_access.result]
}

# ------------------------------------------------------------------ workload identities

# The migrate job owns the schema; the api and worker can read and write rows but not change tables.
resource "azurerm_user_assigned_identity" "migrate" {
  name                = "id-${local.name}-migrate"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.name}-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "migrate_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.migrate.principal_id
}

resource "azurerm_role_assignment" "app_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_vault_secrets" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ------------------------------------------------------------------ deployment identity (no secret)

resource "azurerm_user_assigned_identity" "deploy" {
  count               = var.github_repository == null ? 0 : 1
  name                = "id-${local.name}-deploy"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

# Only a workflow run from this repository, in the GitHub environment named like this deployment, can
# sign in as the deployment identity. No client secret to leak or rotate.
resource "azurerm_federated_identity_credential" "deploy" {
  count                     = var.github_repository == null ? 0 : 1
  name                      = "github-${var.environment}"
  user_assigned_identity_id = azurerm_user_assigned_identity.deploy[0].id
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "repo:${var.github_repository}:environment:${var.environment}"
  audience                  = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "deploy_acr_push" {
  count                = var.github_repository == null ? 0 : 1
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.deploy[0].principal_id
}

# Contributor on the resource group is the simplest grant that can update container apps and start the
# migrate job. It is wider than needed; narrowing it to a custom role is listed in the README.
resource "azurerm_role_assignment" "deploy_contributor" {
  count                = var.github_repository == null ? 0 : 1
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.deploy[0].principal_id
}

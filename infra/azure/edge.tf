# The public edge. Anyone can read published announcements and the Atom feed, so a crowd after a big
# announcement lands here, not on the database: Front Door answers repeat reads from its cache (the API
# marks public reads cacheable for 30 seconds, the feed for 60) and a single rate rule keeps the subscription
# form from being used to mail strangers. The local twin does the same with the nginx cache (apps/web/nginx.conf).
#
# Premium is what the managed WAF rule sets and Private Link to the origin need (README, "What it costs"); the
# Standard tier remains for a dev environment that turns both off.

locals {
  edge_premium = var.private_ingress || var.waf_managed_rules
}

resource "azurerm_cdn_frontdoor_profile" "main" {
  count               = var.enable_front_door ? 1 : 0
  name                = "afd-${local.name}"
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = local.edge_premium ? "Premium_AzureFrontDoor" : "Standard_AzureFrontDoor"
  tags                = local.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "main" {
  count                    = var.enable_front_door ? 1 : 0
  name                     = "fde-${local.unique}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "api" {
  count                    = var.enable_front_door ? 1 : 0
  name                     = "api"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id

  load_balancing {}

  # A replica that is not ready answers 503 and drops out of the container app's rotation by itself;
  # this probe only tells the edge whether the app as a whole can serve.
  health_probe {
    path                = "/readyz"
    protocol            = "Https"
    request_type        = "GET"
    interval_in_seconds = 30
  }
}

resource "azurerm_cdn_frontdoor_origin" "api" {
  count                          = var.enable_front_door ? 1 : 0
  name                           = "api"
  cdn_frontdoor_origin_group_id  = azurerm_cdn_frontdoor_origin_group.api[0].id
  enabled                        = true
  host_name                      = azurerm_container_app.api.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.api.ingress[0].fqdn
  certificate_name_check_enabled = true
  http_port                      = 80
  https_port                     = 443
  priority                       = 1
  weight                         = 1000

  # Private Link: Front Door asks for a private endpoint into the Container Apps environment. The connection
  # waits for approval (scripts/approve-private-link.sh); until then the edge answers 502 and nothing is exposed.
  dynamic "private_link" {
    for_each = var.private_ingress ? [1] : []
    content {
      location               = azurerm_resource_group.main.location
      private_link_target_id = azurerm_container_app_environment.main.id
      target_type            = "managedEnvironments"
      request_message        = "Front Door ${local.name}"
    }
  }
}

# Public reads: cached, compressed, one cache entry per query string (the filters are in it).
resource "azurerm_cdn_frontdoor_route" "public" {
  count                         = var.enable_front_door ? 1 : 0
  name                          = "public-reads"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.main[0].id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.api[0].id
  cdn_frontdoor_origin_ids      = concat([azurerm_cdn_frontdoor_origin.api[0].id], local.dr_origin_ids)
  patterns_to_match             = ["/api/public/*"]
  supported_protocols           = ["Http", "Https"]
  https_redirect_enabled        = true
  forwarding_protocol           = "HttpsOnly"
  link_to_default_domain        = true

  # No rule set overrides the lifetime: Front Door honours the Cache-Control the API sends. POSTs (the
  # subscription form) are never cached whatever the route says.
  cache {
    query_string_caching_behavior = "UseQueryString"
    compression_enabled           = true
    content_types_to_compress     = ["application/json"] # Front Door cannot compress application/atom+xml (not in its list); the feed is small
  }
}

# Everything else (the web app, the staff API): passed through, never cached.
resource "azurerm_cdn_frontdoor_route" "app" {
  count                         = var.enable_front_door ? 1 : 0
  name                          = "app"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.main[0].id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.api[0].id
  cdn_frontdoor_origin_ids      = concat([azurerm_cdn_frontdoor_origin.api[0].id], local.dr_origin_ids)
  patterns_to_match             = ["/*"]
  supported_protocols           = ["Http", "Https"]
  https_redirect_enabled        = true
  forwarding_protocol           = "HttpsOnly"
  link_to_default_domain        = true
}

resource "azurerm_cdn_frontdoor_firewall_policy" "main" {
  count               = var.enable_front_door ? 1 : 0
  name                = replace("afdwaf${local.name}", "-", "")
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = azurerm_cdn_frontdoor_profile.main[0].sku_name
  enabled             = true
  mode                = "Prevention"
  tags                = local.tags

  # Microsoft's managed rules: the common web attacks (default rule set) and known bad bots. They start in
  # Log so real traffic can be read before anything is blocked (README, "Turning the WAF to Block").
  dynamic "managed_rule" {
    for_each = var.waf_managed_rules ? {
      Microsoft_DefaultRuleSet    = "2.1"
      Microsoft_BotManagerRuleSet = "1.1"
    } : {}
    content {
      type    = managed_rule.key
      version = managed_rule.value
      action  = var.waf_managed_rules_action
    }
  }

  custom_rule {
    name                           = "SubscribeRate"
    enabled                        = true
    priority                       = 1
    type                           = "RateLimitRule"
    action                         = "Block"
    rate_limit_duration_in_minutes = 1
    rate_limit_threshold           = var.edge_subscribe_rate_limit_per_minute

    match_condition {
      match_variable     = "RequestMethod"
      operator           = "Equal"
      negation_condition = false
      match_values       = ["POST"]
    }

    match_condition {
      match_variable     = "RequestUri"
      operator           = "Contains"
      negation_condition = false
      match_values       = ["/api/public/subscriptions"]
      transforms         = ["Lowercase"]
    }
  }
}

resource "azurerm_cdn_frontdoor_security_policy" "main" {
  count                    = var.enable_front_door ? 1 : 0
  name                     = "waf"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.main[0].id

  security_policies {
    firewall {
      cdn_frontdoor_firewall_policy_id = azurerm_cdn_frontdoor_firewall_policy.main[0].id

      association {
        patterns_to_match = ["/*"]

        domain {
          cdn_frontdoor_domain_id = azurerm_cdn_frontdoor_endpoint.main[0].id
        }
      }
    }
  }
}

resource "azurerm_monitor_diagnostic_setting" "frontdoor" {
  count                      = var.enable_front_door ? 1 : 0
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_cdn_frontdoor_profile.main[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "FrontDoorAccessLog"
  }

  enabled_log {
    category = "FrontDoorWebApplicationFirewallLog"
  }
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_monitor_action_group" "ops" {
  name                = "ag-${local.name}-ops"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = "hubops"
  tags                = local.tags

  email_receiver {
    name                    = "on-call"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
}

# Platform logs of the database go to the same workspace as the application's.
resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "allLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "vault" {
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "audit"
  }
}

# ------------------------------------------------------------------ alerts: each one needs a person

locals {
  alert_common = {
    action_group = azurerm_monitor_action_group.ops.id
  }
}

# Fewer replicas than the floor: a zone is down, a deploy is stuck, or the app keeps crashing.
resource "azurerm_monitor_metric_alert" "api_replicas" {
  name                = "${local.name}-api-replicas-below-minimum"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.api.id]
  description         = "The API has fewer replicas than its minimum for 15 minutes."
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Replicas"
    aggregation      = "Minimum"
    operator         = "LessThan"
    threshold        = var.api_replicas.min
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

resource "azurerm_monitor_metric_alert" "worker_replicas" {
  name                = "${local.name}-worker-replicas-below-minimum"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.worker.id]
  description         = "The worker has fewer replicas than its minimum for 15 minutes: publications will not be sent."
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Replicas"
    aggregation      = "Minimum"
    operator         = "LessThan"
    threshold        = var.worker_replicas.min
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

resource "azurerm_monitor_metric_alert" "api_restarts" {
  name                = "${local.name}-api-restarting"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.api.id]
  description         = "Containers restarted more than 3 times in 15 minutes."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 3
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

resource "azurerm_monitor_metric_alert" "api_5xx" {
  name                = "${local.name}-api-server-errors"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.api.id]
  description         = "More than 10 server errors in 5 minutes."
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Requests"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 10

    dimension {
      name     = "statusCodeCategory"
      operator = "Include"
      values   = ["5xx"]
    }
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

resource "azurerm_monitor_metric_alert" "postgres_cpu" {
  name                = "${local.name}-postgres-cpu"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Database CPU above 80 % for 15 minutes: time to look at queries, then at the SKU."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

resource "azurerm_monitor_metric_alert" "postgres_storage" {
  name                = "${local.name}-postgres-storage"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Database storage above 80 %."
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT1H"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "storage_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

resource "azurerm_monitor_metric_alert" "postgres_connections" {
  name                = "${local.name}-postgres-connections"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Active connections above 70 % of what the replica ceiling needs: raise the SKU or lower PG_POOL_MAX before adding replicas."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "active_connections"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    # (api max + worker max + migrate) x PG_POOL_MAX x 70 %
    threshold = floor((var.api_replicas.max + var.worker_replicas.max + 1) * 5 * 0.7)
  }

  action {
    action_group_id = local.alert_common.action_group
  }
}

# A publication that ran out of attempts is the event the business cares about most.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "publication_failed" {
  name                 = "${local.name}-publication-failed"
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_resource_group.main.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  description          = "A publication attempt failed. Check whether it will be retried or needs a person."
  severity             = 1
  evaluation_frequency = "PT5M"
  window_duration      = "PT5M"
  tags                 = local.tags

  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs_CL
      | where Log_s has "publication failed"
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}

# ------------------------------------------------------------------ budget

resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "budget-${local.name}"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.monthly_budget_eur
  time_grain        = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = [var.alert_email]
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = [var.alert_email]
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = [var.alert_email]
  }

  lifecycle {
    # The start date is only evaluated when the budget is created.
    ignore_changes = [time_period]
  }
}
